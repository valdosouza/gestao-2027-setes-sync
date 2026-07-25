import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Movimento de Estoque — id local ✅ (CET_CODIGO, MAPA_INDEXACAO).
 * ATENÇÃO: o trigger MySQL `after_stock_statement_insert` atualiza
 * tb_stock_balance automaticamente no INSERT — NÃO replicar essa lógica
 * aqui (reenvio do mesmo id cai no UPDATE e não dispara o trigger de novo).
 * ACHADO: a PK de tb_stock_statement é SÓ `id` (auto_increment) — ids locais
 * de institutions diferentes podem colidir; por isso o upsert confere
 * id+institution+terminal antes de inserir. merchandiseId/orderId são
 * referências locais já sincronizadas — ausentes = 409 de reenvio.
 * Contrato: CONTRATOS_SYNC.md.
 */
const stockStatementBody = z.object({
  id:            z.number().int().positive(),
  terminal:      z.number().int().min(0),
  orderId:       z.number().int().min(0).optional().default(0),
  orderItemId:   z.number().int().min(0).optional().default(0),
  stockListId:   z.number().int().min(0).optional().default(0),
  merchandiseId: z.number().int().positive(),
  local:         z.string().max(25).nullable().optional(),
  kind:          z.string().max(25).nullable().optional(),
  dtRecord:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction:     z.string().trim().length(1),
  quantity:      z.number(),
  operation:     z.string().max(50).nullable().optional(),
  note:          z.string().max(100).nullable().optional(),
  deleted:       z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /stock-statement/sincronize:
 *   post:
 *     summary: Sincronizar Movimento de Estoque (id local)
 *     description: >-
 *       Upsert em tb_stock_statement com id = CET_CODIGO. merchandiseId
 *       inexistente = 409 MERCHANDISE_NOT_SYNCED; orderId informado (> 0) e
 *       inexistente = 409 ORDER_NOT_SYNCED (reenvio no próximo ciclo).
 *       O trigger after_stock_statement_insert mantém tb_stock_balance.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, merchandiseId, dtRecord, direction, quantity]
 *             properties:
 *               id: { type: integer, example: 4501 }
 *               terminal: { type: integer, example: 1 }
 *               orderId: { type: integer, example: 3021 }
 *               orderItemId: { type: integer, example: 2 }
 *               stockListId: { type: integer, example: 1 }
 *               merchandiseId: { type: integer, example: 501 }
 *               local: { type: string, example: "DEPOSITO" }
 *               kind: { type: string, example: "VENDA" }
 *               dtRecord: { type: string, example: "2026-07-19" }
 *               direction: { type: string, example: "S" }
 *               quantity: { type: number, example: 3.5 }
 *               operation: { type: string, example: "SAIDA POR VENDA" }
 *               note: { type: string }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Mercadoria/pedido ainda não sincronizados — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/stock-statement/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = stockStatementBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const b = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    // Referências locais já sincronizadas — 409 de reenvio
    const [merch] = await conn.query<any[]>(
      `SELECT id FROM tb_merchandise
       WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' LIMIT 1`,
      [b.merchandiseId, institutionId]
    )
    if (!merch.length) {
      throw new HttpError(409, `Mercadoria ${b.merchandiseId} ainda não sincronizada`,
        [{ field: 'merchandiseId', message: 'sincronize a mercadoria antes — reenvio no próximo ciclo' }],
        'MERCHANDISE_NOT_SYNCED')
    }
    if (b.orderId > 0) {
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
    }

    // Upsert MANUAL: a PK física é só `id` — conferir institution+terminal
    // evita sobrescrever registro homônimo de outra institution
    const [existing] = await conn.query<any[]>(
      `SELECT id FROM tb_stock_statement
       WHERE id = ? AND tb_institution_id = ? AND terminal = ? LIMIT 1 FOR UPDATE`,
      [b.id, institutionId, b.terminal]
    )
    if (existing.length) {
      await conn.query(
        `UPDATE tb_stock_statement
         SET tb_order_id = ?, tb_order_item_id = ?, tb_stock_list_id = ?,
             \`local\` = ?, kind = ?, dt_record = ?, direction = ?,
             tb_merchandise_id = ?, quantity = ?, operation = ?, note = ?,
             deleted = ?, updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ? AND terminal = ?`,
        [b.orderId, b.orderItemId, b.stockListId, b.local ?? null, b.kind ?? null,
         b.dtRecord, b.direction, b.merchandiseId, b.quantity, b.operation ?? null,
         b.note ?? null, b.deleted, b.id, institutionId, b.terminal]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_stock_statement
           (id, tb_institution_id, terminal, tb_order_id, tb_order_item_id,
            tb_stock_list_id, \`local\`, kind, dt_record, direction,
            tb_merchandise_id, quantity, operation, note, deleted,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [b.id, institutionId, b.terminal, b.orderId, b.orderItemId, b.stockListId,
         b.local ?? null, b.kind ?? null, b.dtRecord, b.direction, b.merchandiseId,
         b.quantity, b.operation ?? null, b.note ?? null, b.deleted]
      )
    }

    await conn.commit()
    res.json(syncSuccess(b.id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /stock-statement/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
