import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { invoiceBody, resolveInvoiceRefs, upsertInvoice } from './invoice'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Nota Fiscal de SERVIÇO (vinculada a pedido) — decisões D1/D3 do
 * prompt_notas_mercadoria_servico.md (2026-07-26). Espelha o
 * /invoice-merchandise: a nota é genérica e vira "de serviço" pela PRESENÇA
 * do ramo tb_invoice_service (nota conjugada do legado = os dois endpoints
 * disparam para o MESMO id, cada um gravando seu ramo). O bloco `service`
 * carrega o total do serviço (NFL_VL_TL_SRV) — ramo mínimo, cresce quando
 * houver fato gerador (emissão nativa de NFS-e). Vínculo nota×pedido é a
 * própria PK (id = NFL_CODIGO = tb_order.id — D1): pedido com o MESMO id →
 * 409 ORDER_NOT_SYNCED. O RPS/lote/protocolo NÃO passam aqui — vivem no
 * /invoice-return-service (D4).
 * RODADA 2 (D10, 2026-07-27): este endpoint SAIU do catálogo do Delphi — o
 * processo completo de serviço viaja pelo /order-service (bloco `invoice`).
 * Ele permanece na web como canal de NOTA ISOLADA. Contrato: CONTRATOS_SYNC.md.
 */
export const serviceRamoBlock = z.object({
  totalValue: z.number().nullish(),
})

const invoiceServiceBody = invoiceBody.extend({
  service: serviceRamoBlock.optional().default({}),
})

export type ServiceRamoInput = z.infer<typeof serviceRamoBlock>

/**
 * Upsert do ramo tb_invoice_service (a PRESENÇA define a natureza — D3).
 * Reusado pelo endpoint de PROCESSO /order-service (D9/D10).
 * Pressupõe `USE <schema>` já executado.
 */
export async function upsertServiceRamo(
  conn: import('mysql2/promise').PoolConnection, institutionId: number,
  id: number, terminal: number, s: ServiceRamoInput, deleted: 'S' | 'N'
): Promise<void> {
  await conn.query(
    `INSERT INTO tb_invoice_service
       (id, tb_institution_id, terminal, total_value, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       total_value = VALUES(total_value), deleted = VALUES(deleted), updated_at = NOW()`,
    [id, institutionId, terminal, s.totalValue ?? null, deleted]
  )
}

/**
 * @swagger
 * /invoice-service/sincronize:
 *   post:
 *     summary: Sincronizar Nota Fiscal de serviço (nota + ramo tb_invoice_service)
 *     description: >-
 *       Payload do /invoice/sincronize + bloco service (totalValue =
 *       NFL_VL_TL_SRV). Grava tb_invoice E o ramo tb_invoice_service — a
 *       natureza da nota é a PRESENÇA do ramo (D3); nota conjugada = este
 *       endpoint e o /invoice-merchandise para o mesmo id. Vínculo
 *       nota×pedido é a própria PK (id = NFL_CODIGO = tb_order.id — D1):
 *       pedido inexistente = 409 ORDER_NOT_SYNCED. RPS/lote/protocolo vivem
 *       no /invoice-return-service.
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
 *               id: { type: integer, example: 78, description: NFL_CODIGO = tb_order.id }
 *               terminal: { type: integer, example: 1 }
 *               issuer: { type: string, enum: [S, N], example: "S" }
 *               kindEmis: { type: string, example: "SE" }
 *               finality: { type: string, example: "1" }
 *               number: { type: string, example: "000124" }
 *               serie: { type: string, example: "1" }
 *               cfopId: { type: string, example: "5933" }
 *               entityDocument: { type: string, example: "52998224725" }
 *               dtEmission: { type: string, example: "2026-07-26" }
 *               value: { type: number, example: 980 }
 *               note: { type: string }
 *               status: { type: string, example: "A" }
 *               deleted: { type: string, enum: [S, N] }
 *               service:
 *                 type: object
 *                 description: Dados do ramo de serviço
 *                 properties:
 *                   totalValue: { type: number, example: 350.5, description: NFL_VL_TL_SRV }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Pedido/entidade/CFOP ainda não sincronizados — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/invoice-service/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = invoiceServiceBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const b = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    const refs = await resolveInvoiceRefs(conn, b)

    await conn.query(`USE \`${schemaName}\``)

    // Pedido com o MESMO id (D1: id = NFL_CODIGO = tb_order.id) — 409 de reenvio
    const [orders] = await conn.query<any[]>(
      `SELECT id FROM tb_order
       WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N' LIMIT 1`,
      [b.id, institutionId, b.terminal]
    )
    if (!orders.length) {
      throw new HttpError(409, `Pedido ${b.id} ainda não sincronizado`,
        [{ field: 'id', message: 'sincronize o pedido antes — reenvio no próximo ciclo' }],
        'ORDER_NOT_SYNCED')
    }

    await upsertInvoice(conn, institutionId, b, refs)

    // Ramo tb_invoice_service — a presença define a natureza (D3)
    await upsertServiceRamo(conn, institutionId, b.id, b.terminal, b.service, b.deleted)

    await conn.commit()
    res.json(syncSuccess(b.id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /invoice-service/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
