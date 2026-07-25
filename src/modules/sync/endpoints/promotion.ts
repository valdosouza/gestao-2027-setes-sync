import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Promoção — ID LOCAL ✅ (MAPA_INDEXACAO #10): id do Firebird É o id na web
 * (tb_promotion, PK institution+id). Cabeçalho com as colunas reais do DDL
 * (price_tag/quantity/reg_active/oper) + itens em tb_promotion_items
 * (PK institution+promotion+product) — snapshot: itens presentes são
 * upsertados e itens ausentes do payload viram deleted='S' (quando `items`
 * é enviado). Produto do item ainda não sincronizado → 409 (reenvio no
 * próximo ciclo). deleted='S' = soft delete (D2). Contrato: CONTRATOS_SYNC.md.
 */
const promotionBody = z.object({
  id:          z.number().int().positive(),
  description: z.string().trim().min(1).max(100),
  priceTag:    z.number().optional().nullable(),
  quantity:    z.number().optional().nullable(),
  active:      z.enum(['S', 'N']).optional().default('S'),
  oper:        z.string().trim().max(1).optional().nullable(),
  deleted:     z.enum(['S', 'N']).optional().default('N'),
  items:       z.array(z.object({
    productId: z.number().int().positive(),
    oper:      z.string().trim().max(1).optional().nullable(),
    deleted:   z.enum(['S', 'N']).optional().default('N'),
  })).optional(),
})

/**
 * @swagger
 * /promotion/sincronize:
 *   post:
 *     summary: Sincronizar Promoção (id local, cabeçalho + itens)
 *     description: >-
 *       Upsert em tb_promotion do schema do cliente com id local do Firebird
 *       (PK institution+id). Se `items` for enviado, faz snapshot em
 *       tb_promotion_items (itens ausentes viram deleted='S'). Produto de
 *       item inexistente = 409 (reenvio no próximo ciclo). deleted='S' =
 *       soft delete.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, description]
 *             properties:
 *               id: { type: integer, example: 7 }
 *               description: { type: string, example: "QUEIMA DE ESTOQUE" }
 *               priceTag: { type: number, example: 9.99 }
 *               quantity: { type: number, example: 10 }
 *               active: { type: string, enum: [S, N] }
 *               oper: { type: string, maxLength: 1 }
 *               deleted: { type: string, enum: [S, N] }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [productId]
 *                   properties:
 *                     productId: { type: integer, example: 152 }
 *                     oper: { type: string, maxLength: 1 }
 *                     deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Produto de item ainda não sincronizado }
 *       500: { description: Erro ao processar }
 */
router.post('/promotion/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = promotionBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, description, priceTag, quantity, active, oper, deleted, items } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    await conn.query(
      `INSERT INTO tb_promotion
         (tb_institution_id, id, description, price_tag, quantity, reg_active, oper, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         description = VALUES(description), price_tag = VALUES(price_tag),
         quantity = VALUES(quantity), reg_active = VALUES(reg_active),
         oper = VALUES(oper), deleted = VALUES(deleted), updated_at = NOW()`,
      [institutionId, id, description, priceTag ?? null, quantity ?? null, active, oper ?? null, deleted]
    )

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
          `INSERT INTO tb_promotion_items
             (tb_institution_id, tb_promotion_id, tb_product_id, oper, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             oper = VALUES(oper), deleted = VALUES(deleted), updated_at = NOW()`,
          [institutionId, id, item.productId, item.oper ?? null, item.deleted]
        )
      }
      // Snapshot: itens que não vieram no payload saem da promoção (soft delete)
      const keptIds = items.map(i => i.productId)
      if (keptIds.length) {
        await conn.query(
          `UPDATE tb_promotion_items SET deleted = 'S', updated_at = NOW()
           WHERE tb_institution_id = ? AND tb_promotion_id = ?
             AND tb_product_id NOT IN (?) AND deleted = 'N'`,
          [institutionId, id, keptIds]
        )
      } else {
        await conn.query(
          `UPDATE tb_promotion_items SET deleted = 'S', updated_at = NOW()
           WHERE tb_institution_id = ? AND tb_promotion_id = ? AND deleted = 'N'`,
          [institutionId, id]
        )
      }
    }

    await conn.commit()
    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /promotion/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
