import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { findEntityIdByDocument } from '../sync.entity'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Nota Fiscal avulsa — id local ✅ (NFL_CODIGO, MAPA_INDEXACAO): PK composta
 * id + institution + terminal em tb_invoice. Destinatário/remetente por
 * DOCUMENTO (D3): entityDocument → entity.id da central — informado e não
 * sincronizado = 409 ENTITY_NOT_SYNCED (reenvio no próximo ciclo).
 * `issuer` na tabela é INT: quando o emitente é a própria institution
 * (payload issuer='S', nota de saída) grava o institutionId (mesmo padrão do
 * módulo service-orders da setes-api); issuer='N' = terceiro emitiu → grava o
 * entity.id resolvido de entityDocument (obrigatório nesse caso).
 * CFOP: o id de setes_central.tb_cfop É o próprio código (varchar) —
 * desconhecido = 409 CFOP_NOT_FOUND. Contrato: CONTRATOS_SYNC.md.
 */
export const invoiceBody = z.object({
  id:             z.number().int().positive(),
  terminal:       z.number().int().min(0),
  issuer:         z.enum(['S', 'N']).optional().default('S'),
  kindEmis:       z.string().trim().min(1).max(50),
  finality:       z.string().max(2).nullable().optional(),
  number:         z.union([z.string().trim().min(1).max(20), z.number().int().positive()]),
  serie:          z.union([z.string().max(10), z.number().int()]).nullable().optional(),
  cfopId:         z.union([z.string().trim().min(1).max(10), z.number().int().positive()]).nullable().optional(),
  entityDocument: z.string().trim().min(11).max(18).optional(),
  dtEmission:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value:          z.number(),
  model:          z.string().max(2).nullable().optional(),
  note:           z.string().nullable().optional(),
  status:         z.string().trim().min(1).max(1).optional().default('A'),
  deleted:        z.enum(['S', 'N']).optional().default('N'),
})

export type InvoiceInput = z.infer<typeof invoiceBody>

export interface InvoiceRefs {
  /** entity.id do destinatário/emitente terceiro (0 = sem entidade — ex.: NFC-e consumidor). */
  entityId: number
  /** Código CFOP validado na central (null = não informado). */
  cfopId:   string | null
}

/**
 * Resolve as referências CENTRAIS da nota (entidade por documento + CFOP).
 * Chamar ANTES do `USE <schema>` — consultas qualificadas em setes_central.
 */
export async function resolveInvoiceRefs(
  conn: PoolConnection, b: InvoiceInput
): Promise<InvoiceRefs> {
  let entityId = 0
  if (b.entityDocument) {
    const found = await findEntityIdByDocument(conn, b.entityDocument)
    if (found === null) {
      throw new HttpError(409, `Entidade ${b.entityDocument} ainda não sincronizada`,
        [{ field: 'entityDocument', message: 'sincronize a entidade antes — reenvio no próximo ciclo' }],
        'ENTITY_NOT_SYNCED')
    }
    entityId = found
  }
  if (b.issuer === 'N' && entityId === 0) {
    throw new HttpError(400, 'entityDocument é obrigatório quando issuer=\'N\'',
      [{ field: 'entityDocument', message: 'nota de terceiro exige o documento do emitente' }])
  }

  let cfopId: string | null = null
  if (b.cfopId !== null && b.cfopId !== undefined) {
    const code = String(b.cfopId).trim()
    const [cfops] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_cfop WHERE id = ? AND deleted = 'N' LIMIT 1`,
      [code]
    )
    if (!cfops.length) {
      throw new HttpError(409, `CFOP ${code} não encontrado na central`,
        [{ field: 'cfopId', message: 'inclua o CFOP no catálogo central e reenvie' }],
        'CFOP_NOT_FOUND')
    }
    cfopId = String(cfops[0].id)
  }

  return { entityId, cfopId }
}

/**
 * Upsert em tb_invoice (PK id+institution+terminal). Pressupõe `USE <schema>`
 * já executado e refs resolvidas. tb_invoice NÃO tem coluna de pedido — o
 * vínculo nota×pedido do legado é só VALIDADO no /invoice-merchandise.
 */
export async function upsertInvoice(
  conn: PoolConnection, institutionId: number, b: InvoiceInput, refs: InvoiceRefs
): Promise<void> {
  const issuerValue = b.issuer === 'S' ? institutionId : refs.entityId
  await conn.query(
    `INSERT INTO tb_invoice
       (id, tb_institution_id, terminal, issuer, kind_emis, finality, number,
        serie, tb_cfop_id, tb_entity_id, dt_emission, value, model, note,
        status, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       issuer = VALUES(issuer), kind_emis = VALUES(kind_emis),
       finality = VALUES(finality), number = VALUES(number),
       serie = VALUES(serie), tb_cfop_id = VALUES(tb_cfop_id),
       tb_entity_id = VALUES(tb_entity_id), dt_emission = VALUES(dt_emission),
       value = VALUES(value), model = VALUES(model), note = VALUES(note),
       status = VALUES(status), deleted = VALUES(deleted), updated_at = NOW()`,
    [b.id, institutionId, b.terminal, issuerValue, b.kindEmis, b.finality ?? null,
     String(b.number), b.serie === null || b.serie === undefined ? null : String(b.serie),
     refs.cfopId, refs.entityId, b.dtEmission, b.value, b.model ?? null,
     b.note ?? null, b.status, b.deleted]
  )
}

/**
 * @swagger
 * /invoice/sincronize:
 *   post:
 *     summary: Sincronizar Nota Fiscal avulsa (id local + entidade por documento)
 *     description: >-
 *       Upsert em tb_invoice do schema do cliente com id = NFL_CODIGO (PK
 *       id+institution+terminal). entityDocument (CPF/CNPJ do destinatário —
 *       ou do emitente quando issuer='N') resolvido em setes_central — não
 *       sincronizado = 409 ENTITY_NOT_SYNCED. cfopId = código CFOP (id da
 *       setes_central.tb_cfop) — desconhecido = 409 CFOP_NOT_FOUND.
 *       issuer='S' = emitente é a própria institution (nota de saída).
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, kindEmis, number, dtEmission, value]
 *             properties:
 *               id: { type: integer, example: 77 }
 *               terminal: { type: integer, example: 1 }
 *               issuer: { type: string, enum: [S, N], example: "S" }
 *               kindEmis: { type: string, example: "EM" }
 *               finality: { type: string, example: "1" }
 *               number: { type: string, example: "000123" }
 *               serie: { type: string, example: "1" }
 *               cfopId: { type: string, example: "5102" }
 *               entityDocument: { type: string, example: "11222333000181" }
 *               dtEmission: { type: string, example: "2026-07-19" }
 *               value: { type: number, example: 150.5 }
 *               model: { type: string, example: "55" }
 *               note: { type: string }
 *               status: { type: string, example: "A" }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Entidade/CFOP ainda não sincronizados — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/invoice/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = invoiceBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const b = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    const refs = await resolveInvoiceRefs(conn, b)

    await conn.query(`USE \`${schemaName}\``)
    await upsertInvoice(conn, institutionId, b, refs)

    await conn.commit()
    res.json(syncSuccess(b.id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /invoice/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
