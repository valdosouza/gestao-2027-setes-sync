import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { PoolConnection } from 'mysql2/promise'
import { syncSuccess, syncError } from '../sync.response'
import { findEntityIdByDocument } from '../sync.entity'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * AJUSTE DE ESTOQUE (Onda 5). ID LOCAL ✅ (MAPA_INDEXACAO): PED_CODIGO É o
 * id na web (tb_order, PK id+institution+terminal — `terminal` do payload).
 * Entidade do ajuste é OPCIONAL: entityDocument → entity.id na central
 * (409 ENTITY_NOT_SYNCED se desconhecido); ausente → 0 (tb_entity_id é
 * NOT NULL sem FK — sentinela "sem entidade"). Produto do item por id
 * local → 409 PRODUCT_NOT_SYNCED. `items` presente = SNAPSHOT (kind fixo
 * 'Adjust'). tb_order.tb_user_id NOT NULL com FK central: usa o usuário
 * mais antigo do institution (tb_institution_has_user). Transação ÚNICA;
 * deleted='S' em cascata (D2). Contrato: CONTRATOS_SYNC.md.
 */
const itemBody = z.object({
  id:              z.number().int().positive(),
  productId:       z.number().int().positive(),
  quantity:        z.number(),
  unitValue:       z.number().optional().nullable(),
  discountAliquot: z.number().optional().nullable(),
  discountValue:   z.number().optional().nullable(),
})

const orderStockAdjustBody = z.object({
  id:       z.number().int().positive(),
  terminal: z.number().int().min(0),
  deleted:  z.enum(['S', 'N']).optional().default('N'),
  order: z.object({
    dtRecord: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    note:     z.string().optional().nullable(),
    status:   z.string().max(1).optional().nullable(),
    origin:   z.string().max(1).optional().default('D'),
  }).optional().default({}),
  adjust: z.object({
    number:         z.number().int().optional().nullable(),
    entityDocument: z.string().trim().min(11).max(18).optional(),
    direction:      z.string().trim().length(1),
  }),
  items: z.array(itemBody).optional(),
})

/** tb_order.tb_user_id NOT NULL + FK central — usuário mais antigo do institution. */
async function resolveSyncUserId(conn: PoolConnection, institutionId: number): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT MIN(tb_user_id) AS uid FROM setes_central.tb_institution_has_user
     WHERE tb_institution_id = ? AND deleted = 'N'`,
    [institutionId]
  )
  const uid = rows[0]?.uid
  if (!uid) {
    throw new HttpError(409, 'Institution sem usuário para assinar o pedido',
      [{ field: 'id', message: 'cadastre um usuário do institution antes — reenvio no próximo ciclo' }],
      'INSTITUTION_USER_NOT_FOUND')
  }
  return uid
}

/**
 * @swagger
 * /order-stock-adjust/sincronize:
 *   post:
 *     summary: Sincronizar Ajuste de Estoque (id local + itens em transação)
 *     description: >-
 *       Upsert de tb_order + tb_order_stock_adjust + tb_order_item (kind
 *       'Adjust') com id = PED_CODIGO e `terminal` do payload. Entidade do
 *       ajuste opcional por DOCUMENTO (409 ENTITY_NOT_SYNCED; ausente = 0);
 *       produto por id local (409 PRODUCT_NOT_SYNCED). `items` presente =
 *       snapshot. deleted='S' = soft delete em cascata.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, adjust]
 *             properties:
 *               id: { type: integer, example: 3001 }
 *               terminal: { type: integer, example: 0 }
 *               deleted: { type: string, enum: [S, N] }
 *               order:
 *                 type: object
 *                 properties:
 *                   dtRecord: { type: string, example: "2026-07-19" }
 *                   note: { type: string }
 *                   status: { type: string, maxLength: 1 }
 *                   origin: { type: string, maxLength: 1, example: "D" }
 *               adjust:
 *                 type: object
 *                 required: [direction]
 *                 properties:
 *                   number: { type: integer }
 *                   entityDocument: { type: string, example: "52998224725" }
 *                   direction: { type: string, maxLength: 1, example: "E" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, productId, quantity]
 *                   properties:
 *                     id: { type: integer, example: 1 }
 *                     productId: { type: integer, example: 501 }
 *                     quantity: { type: number, example: 3 }
 *                     unitValue: { type: number }
 *                     discountAliquot: { type: number }
 *                     discountValue: { type: number }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Referência ainda não sincronizada — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/order-stock-adjust/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = orderStockAdjustBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, terminal, deleted, order, adjust, items } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // 1. Entidade do ajuste — OPCIONAL, por DOCUMENTO (D3); ausente = 0
    let entityId = 0
    if (adjust.entityDocument) {
      const found = await findEntityIdByDocument(conn, adjust.entityDocument)
      if (found === null) {
        throw new HttpError(409, `Entidade ${adjust.entityDocument} ainda não sincronizada`,
          [{ field: 'adjust.entityDocument', message: 'sincronize a entidade antes — reenvio no próximo ciclo' }],
          'ENTITY_NOT_SYNCED')
      }
      entityId = found
    }

    const userId = await resolveSyncUserId(conn, institutionId)

    await conn.query(`USE \`${schemaName}\``)

    // 2. tb_order (backbone)
    await conn.query(
      `INSERT INTO tb_order
         (id, tb_institution_id, terminal, tb_user_id, dt_record, note, origin, status, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         dt_record = VALUES(dt_record), note = VALUES(note), origin = VALUES(origin),
         status = VALUES(status), deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, terminal, userId, order.dtRecord ?? null, order.note ?? null,
       order.origin, order.status ?? null, deleted]
    )

    // 3. tb_order_stock_adjust
    await conn.query(
      `INSERT INTO tb_order_stock_adjust
         (id, tb_institution_id, terminal, tb_entity_id, number, direction, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         tb_entity_id = VALUES(tb_entity_id), number = VALUES(number),
         direction = VALUES(direction), deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, terminal, entityId, adjust.number ?? null, adjust.direction, deleted]
    )

    // 4. Itens — SNAPSHOT quando o bloco vem (kind 'Adjust')
    if (items) {
      for (const item of items) {
        const [products] = await conn.query<any[]>(
          `SELECT id FROM tb_product WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
          [item.productId, institutionId]
        )
        if (!products.length) {
          throw new HttpError(409, `Produto ${item.productId} ainda não sincronizado`,
            [{ field: 'items.productId', message: 'sincronize o produto antes — reenvio no próximo ciclo' }],
            'PRODUCT_NOT_SYNCED')
        }
        await conn.query(
          `INSERT INTO tb_order_item
             (id, tb_institution_id, tb_order_id, terminal, kind, tb_product_id,
              quantity, unit_value, discount_aliquot, discount_value, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'Adjust', ?, ?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             tb_product_id = VALUES(tb_product_id), quantity = VALUES(quantity),
             unit_value = VALUES(unit_value), discount_aliquot = VALUES(discount_aliquot),
             discount_value = VALUES(discount_value), deleted = VALUES(deleted), updated_at = NOW()`,
          [item.id, institutionId, id, terminal, item.productId, item.quantity,
           item.unitValue ?? null, item.discountAliquot ?? null, item.discountValue ?? null, deleted]
        )
      }
      const keptIds = items.map(i => i.id)
      await conn.query(
        `UPDATE tb_order_item SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND kind = 'Adjust'
           AND deleted = 'N'${keptIds.length ? ' AND id NOT IN (?)' : ''}`,
        keptIds.length ? [id, institutionId, terminal, keptIds] : [id, institutionId, terminal]
      )
    }

    // 5. Soft delete em cascata (D2)
    if (deleted === 'S') {
      await conn.query(
        `UPDATE tb_order_stock_adjust SET deleted = 'S', updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
        [id, institutionId, terminal]
      )
      await conn.query(
        `UPDATE tb_order_item SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
        [id, institutionId, terminal]
      )
    }

    await conn.commit()
    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /order-stock-adjust/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
