import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { findEntityIdByDocument } from '../sync.entity'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { snFlag } from '@shared/validation'

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
  issuer:         snFlag('S'),
  kindEmis:       z.string().trim().min(1).max(50),
  finality:       z.string().max(2).nullable().optional(),
  // Nota ainda SEM numero e realidade do legado (nao autorizada / NFS-e
  // aguardando RPS) — 1a rodada real 2026-07-27: 2.112 registros barrados
  // por min(1). Aceita vazio/ausente e grava NULL; o reenvio (trigger ao
  // autorizar) atualiza o numero.
  number:         z.union([z.string().trim().max(20), z.number().int()]).nullish(),
  serie:          z.union([z.string().max(10), z.number().int()]).nullable().optional(),
  cfopId:         z.union([z.string().trim().min(1).max(10), z.number().int().positive()]).nullable().optional(),
  // Documento INVÁLIDO/curto do legado = SEM documento (2026-08-01, mesmo
  // precedente da decisão 2 de entidades): a nota espelha sem o vínculo de
  // entidade (caso NFC-e consumidor) em vez de barrar em 400.
  entityDocument: z.preprocess(
    v => {
      if (typeof v !== 'string') return v
      const digits = v.replace(/\D/g, '')
      return digits.length === 11 || digits.length === 14 ? digits : undefined
    },
    z.string().min(11).max(18).optional()
  ),
  dtEmission:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  value:          z.number(),
  model:          z.string().max(2).nullable().optional(),
  note:           z.string().nullable().optional(),
  status:         z.string().trim().min(1).max(1).optional().default('A'),
  deleted:        z.enum(['S', 'N']).optional().default('N'),
})

export type InvoiceInput = z.infer<typeof invoiceBody>

/**
 * Bloco `invoice` dos endpoints de PROCESSO (D9/D10 da rodada 2 — notas M×S):
 * os /order-* recebem o objeto completo (pedido + nota + ramo numa transação);
 * id/terminal/deleted vêm da raiz do payload do pedido.
 */
export const invoiceProcessBlock = invoiceBody.omit({ id: true, terminal: true, deleted: true })

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
    // Dado sujo do legado (2026-08-03): flag de terceiro SEM emitente
    // identificável (documento ausente/inválido). Espelha com entidade 0
    // (mesmo precedente do consumidor NFC-e) em vez de barrar o processo —
    // a informação verdadeira não existe no Firebird.
    logger.warn(`Nota ${b.number ?? '(sem número)'} com issuer='N' sem entityDocument — espelhada com entidade 0`)
  }

  let cfopId: string | null = null
  if (b.cfopId !== null && b.cfopId !== undefined) {
    const code = String(b.cfopId).trim()
    const [cfops] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_cfop WHERE id = ? AND deleted = 'N' LIMIT 1`,
      [code]
    )
    if (!cfops.length) {
      // 1ª rodada real (2026-07-27): a referência central estava vazia e o
      // 409 CFOP_NOT_FOUND barrou 1.384 notas. CFOP vira "catálogo iniciado
      // pelo cliente": auto-cria com descrição placeholder (a tela de CFOPs
      // do Super enriquece depois). Pendência Rodada 4: descrição vinda do
      // legado (TB_NATUREZA) no payload.
      logger.warn(`CFOP ${code} auto-criado (placeholder) na central`)
      await conn.query(
        `INSERT INTO setes_central.tb_cfop (id, description, created_at, updated_at)
         VALUES (?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE deleted = 'N', updated_at = NOW()`,
        [code, `CFOP ${code} (importado do legado — revisar descrição)`]
      )
    }
    cfopId = code
  }

  return { entityId, cfopId }
}

/**
 * Upsert em tb_invoice (PK id+institution+terminal). Pressupõe `USE <schema>`
 * já executado e refs resolvidas. Vínculo nota×pedido (D1 do
 * prompt_notas_mercadoria_servico.md): id = NFL_CODIGO = tb_order.id — a
 * PRÓPRIA PK compartilhada; a natureza da nota é o RAMO
 * (tb_invoice_merchandise × tb_invoice_service — D3). A nota AVULSA
 * (este endpoint) fica sem ramo: NFL_TIPO 'EM' = entrada manual SEM itens.
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
     b.number === null || b.number === undefined || String(b.number).trim() === ''
       ? null : String(b.number),
     b.serie === null || b.serie === undefined ? null : String(b.serie),
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
 *             required: [id, terminal, kindEmis, dtEmission, value]
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
