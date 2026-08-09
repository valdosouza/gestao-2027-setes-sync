import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { invoiceBody, resolveInvoiceRefs, upsertInvoice } from './invoice'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Nota Fiscal de MERCADORIA (vinculada a pedido) — decisões D1/D3 do
 * prompt_notas_mercadoria_servico.md (2026-07-26). A nota sozinha é objeto
 * GENÉRICO: ela é "de mercadoria" porque o ramo tb_invoice_merchandise
 * existe (nota conjugada do legado = este endpoint E o /invoice-service
 * disparam para o MESMO id, cada um gravando seu ramo).
 * VÍNCULO nota×pedido (D1): id = NFL_CODIGO = tb_order.id — o vínculo é a
 * PRÓPRIA PK compartilhada (a antiga pendência de coluna tb_order_id morreu
 * por construção). O pedido precisa existir com o MESMO id → 409
 * ORDER_NOT_SYNCED. O campo `orderId` do contrato antigo (PED_CODIGO, que
 * nunca casava com nada) é aceito e IGNORADO — transição de executáveis
 * antigos.
 * RODADA 2 (D10, 2026-07-27): este endpoint SAIU do catálogo do Delphi — o
 * processo completo viaja pelos /order-* (bloco `invoice`). Ele permanece na
 * web como canal de NOTA ISOLADA (reenvio avulso). Contrato: CONTRATOS_SYNC.md.
 */
export const merchandiseRamoBlock = z.object({
  dtExit:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  tmExit:          z.string().max(8).nullish(),
  baseIcmsValue:   z.number().nullish(),
  icmsValue:       z.number().nullish(),
  baseIcmsStValue: z.number().nullish(),
  icmsStValue:     z.number().nullish(),
  totalValue:      z.number().nullish(),
  freightValue:    z.number().nullish(),
  insuranceValue:  z.number().nullish(),
  expensesValue:   z.number().nullish(),
  ipiValue:        z.number().nullish(),
  discountValue:   z.number().nullish(),
  totalQtty:       z.number().nullish(),
  indPres:         z.number().int().nullish(),
})

const invoiceMerchandiseBody = invoiceBody.extend({
  orderId:     z.number().int().positive().optional(),   // legado — ignorado (D1)
  merchandise: merchandiseRamoBlock.optional().default({}),
})

export type MerchandiseRamoInput = z.infer<typeof merchandiseRamoBlock>

/**
 * Upsert do ramo tb_invoice_merchandise (a PRESENÇA define a natureza — D3).
 * Reusado pelos endpoints de PROCESSO /order-sale, /order-purchase e
 * /order-stock-adjust (D9/D10). Pressupõe `USE <schema>` já executado.
 */
export async function upsertMerchandiseRamo(
  conn: import('mysql2/promise').PoolConnection, institutionId: number,
  id: number, terminal: number, m: MerchandiseRamoInput, deleted: 'S' | 'N'
): Promise<void> {
  await conn.query(
    `INSERT INTO tb_invoice_merchandise
       (id, tb_institution_id, terminal, dt_exit, tm_exit, base_icms_value, icms_value,
        base_icms_st_value, icms_st_value, total_value, freight_value, insurance_value,
        expenses_value, ipi_value, discount_value, total_qtty, indPres, deleted, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       dt_exit = VALUES(dt_exit), tm_exit = VALUES(tm_exit),
       base_icms_value = VALUES(base_icms_value), icms_value = VALUES(icms_value),
       base_icms_st_value = VALUES(base_icms_st_value), icms_st_value = VALUES(icms_st_value),
       total_value = VALUES(total_value), freight_value = VALUES(freight_value),
       insurance_value = VALUES(insurance_value), expenses_value = VALUES(expenses_value),
       ipi_value = VALUES(ipi_value), discount_value = VALUES(discount_value),
       total_qtty = VALUES(total_qtty), indPres = VALUES(indPres),
       deleted = VALUES(deleted), updated_at = NOW()`,
    [id, institutionId, terminal, m.dtExit ?? null, m.tmExit ?? null,
     m.baseIcmsValue ?? null, m.icmsValue ?? null, m.baseIcmsStValue ?? null,
     m.icmsStValue ?? null, m.totalValue ?? null, m.freightValue ?? null,
     m.insuranceValue ?? null, m.expensesValue ?? null, m.ipiValue ?? null,
     m.discountValue ?? 0, m.totalQtty ?? null, m.indPres ?? 0, deleted]
  )
}

/**
 * @swagger
 * /invoice-merchandise/sincronize:
 *   post:
 *     summary: Sincronizar Nota Fiscal de mercadoria (nota + ramo tb_invoice_merchandise)
 *     description: >-
 *       Payload do /invoice/sincronize + bloco merchandise (dados do ramo).
 *       Grava tb_invoice E o ramo tb_invoice_merchandise — a natureza da nota
 *       é a PRESENÇA do ramo (D3); nota conjugada = este endpoint e o
 *       /invoice-service para o mesmo id. Vínculo nota×pedido é a própria PK
 *       (id = NFL_CODIGO = tb_order.id — D1): o pedido precisa existir com o
 *       MESMO id → 409 ORDER_NOT_SYNCED. orderId legado é ignorado.
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
 *               cfopId: { type: string, example: "5102" }
 *               entityDocument: { type: string, example: "52998224725" }
 *               dtEmission: { type: string, example: "2026-07-26" }
 *               value: { type: number, example: 980 }
 *               model: { type: string, example: "55" }
 *               note: { type: string }
 *               status: { type: string, example: "A" }
 *               deleted: { type: string, enum: [S, N] }
 *               merchandise:
 *                 type: object
 *                 description: Dados do ramo de mercadoria (NFL_*)
 *                 properties:
 *                   dtExit: { type: string, example: "2026-07-26" }
 *                   tmExit: { type: string, example: "14:30:00" }
 *                   baseIcmsValue: { type: number }
 *                   icmsValue: { type: number }
 *                   baseIcmsStValue: { type: number }
 *                   icmsStValue: { type: number }
 *                   totalValue: { type: number, example: 980 }
 *                   freightValue: { type: number }
 *                   insuranceValue: { type: number }
 *                   expensesValue: { type: number }
 *                   ipiValue: { type: number }
 *                   discountValue: { type: number }
 *                   totalQtty: { type: number }
 *                   indPres: { type: integer, example: 1 }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Pedido/entidade/CFOP ainda não sincronizados — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/invoice-merchandise/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = invoiceMerchandiseBody.safeParse(req.body)
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

    // Ramo tb_invoice_merchandise — a presença define a natureza (D3)
    await upsertMerchandiseRamo(conn, institutionId, b.id, b.terminal, b.merchandise, b.deleted)

    await conn.commit()
    res.json(syncSuccess(b.id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /invoice-merchandise/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
