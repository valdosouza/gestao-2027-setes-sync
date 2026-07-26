import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { invoiceBody, resolveInvoiceRefs, upsertInvoice } from './invoice'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Nota Fiscal de mercadoria (vinculada a pedido) — mesmo contrato do
 * /invoice + orderId (pedido do legado). ACHADO da Onda 5: tb_invoice NÃO
 * tem coluna de pedido (id, institution, terminal, issuer, kind_emis,
 * finality, number, serie, tb_cfop_id, tb_entity_id, dt_emission, value,
 * model, note, status, deleted) — o orderId portanto é apenas VALIDADO
 * (pedido precisa existir em tb_order do schema; ausente = 409
 * ORDER_NOT_SYNCED, reenvio no próximo ciclo) e a nota é gravada sem o
 * vínculo persistido. Se o vínculo nota×pedido precisar viver na web, é
 * decisão de DDL fora desta onda. Contrato: CONTRATOS_SYNC.md.
 */
const invoiceMerchandiseBody = invoiceBody.extend({
  orderId: z.number().int().positive(),
})

/**
 * @swagger
 * /invoice-merchandise/sincronize:
 *   post:
 *     summary: Sincronizar Nota Fiscal de mercadoria (nota + validação do pedido)
 *     description: >-
 *       Mesmo payload do /invoice/sincronize + orderId. O pedido precisa já
 *       estar sincronizado em tb_order (id+institution+terminal) — ausente =
 *       409 ORDER_NOT_SYNCED. tb_invoice não possui coluna de pedido; o
 *       orderId é validado e a nota gravada sem vínculo persistido.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, kindEmis, number, dtEmission, value, orderId]
 *             properties:
 *               id: { type: integer, example: 78 }
 *               terminal: { type: integer, example: 1 }
 *               orderId: { type: integer, example: 3021 }
 *               issuer: { type: string, enum: [S, N], example: "S" }
 *               kindEmis: { type: string, example: "EM" }
 *               finality: { type: string, example: "1" }
 *               number: { type: string, example: "000124" }
 *               serie: { type: string, example: "1" }
 *               cfopId: { type: string, example: "5102" }
 *               entityDocument: { type: string, example: "52998224725" }
 *               dtEmission: { type: string, example: "2026-07-19" }
 *               value: { type: number, example: 980 }
 *               model: { type: string, example: "65" }
 *               note: { type: string }
 *               status: { type: string, example: "A" }
 *               deleted: { type: string, enum: [S, N] }
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

    // Pedido precisa existir (mesmo terminal da nota) — 409 de reenvio
    const [orders] = await conn.query<any[]>(
      `SELECT id FROM tb_order
       WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N' LIMIT 1`,
      [b.orderId, institutionId, b.terminal]
    )
    if (!orders.length) {
      throw new HttpError(409, `Pedido ${b.orderId} ainda não sincronizado`,
        [{ field: 'orderId', message: 'sincronize o pedido antes — reenvio no próximo ciclo' }],
        'ORDER_NOT_SYNCED')
    }

    await upsertInvoice(conn, institutionId, b, refs)

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
