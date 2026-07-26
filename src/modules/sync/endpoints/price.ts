import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Preço — chave COMPOSTA (MAPA_INDEXACAO #7): tb_price tem PK
 * (tb_institution_id, tb_price_list_id, tb_product_id). priceListId e
 * productId são ids locais do Firebird (TPR_CODIGO / PRO_CODIGO). Tabela de
 * preço ou produto ainda não sincronizados → 409 (o Sincronizador reenvia
 * no próximo ciclo — a FK real da tabela exigiria isso de qualquer forma).
 * Campos espelham as colunas reais: price_tag/aliq_profit/aliq_kickback/
 * quantity. deleted='S' = soft delete (D2). Contrato: CONTRATOS_SYNC.md.
 */
const priceBody = z.object({
  priceListId:  z.number().int().positive(),
  productId:    z.number().int().positive(),
  priceTag:     z.number(),
  aliqProfit:   z.number().optional().nullable(),
  aliqKickback: z.number().optional().nullable(),
  quantity:     z.number().optional().nullable(),
  deleted:      z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /price/sincronize:
 *   post:
 *     summary: Sincronizar Preço (chave composta tabela+produto)
 *     description: >-
 *       Upsert em tb_price do schema do cliente pela PK
 *       (institution, priceListId, productId) — ids locais do Firebird.
 *       Tabela de preço ou produto inexistentes = 409 (reenvio no próximo
 *       ciclo). deleted='S' = soft delete.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [priceListId, productId, priceTag]
 *             properties:
 *               priceListId: { type: integer, example: 3 }
 *               productId: { type: integer, example: 152 }
 *               priceTag: { type: number, example: 19.9 }
 *               aliqProfit: { type: number, example: 35.5 }
 *               aliqKickback: { type: number, example: 2.5 }
 *               quantity: { type: number, example: 1 }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id } (id = productId)" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Tabela de preço ou produto ainda não sincronizados }
 *       500: { description: Erro ao processar }
 */
router.post('/price/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = priceBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { priceListId, productId, priceTag, aliqProfit, aliqKickback, quantity, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    const [lists] = await conn.query<any[]>(
      `SELECT id FROM tb_price_list WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
      [priceListId, institutionId]
    )
    if (!lists.length) {
      throw new HttpError(409, `Tabela de preço ${priceListId} ainda não sincronizada`,
        [{ field: 'priceListId', message: 'sincronize a tabela de preço antes — reenvio no próximo ciclo' }],
        'PRICE_LIST_NOT_SYNCED')
    }

    const [products] = await conn.query<any[]>(
      `SELECT id FROM tb_product WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
      [productId, institutionId]
    )
    if (!products.length) {
      throw new HttpError(409, `Produto ${productId} ainda não sincronizado`,
        [{ field: 'productId', message: 'sincronize o produto antes — reenvio no próximo ciclo' }],
        'PRODUCT_NOT_SYNCED')
    }

    await conn.query(
      `INSERT INTO tb_price
         (tb_institution_id, tb_price_list_id, tb_product_id, price_tag, aliq_profit, aliq_kickback, quantity, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         price_tag = VALUES(price_tag), aliq_profit = VALUES(aliq_profit),
         aliq_kickback = VALUES(aliq_kickback), quantity = VALUES(quantity),
         deleted = VALUES(deleted), updated_at = NOW()`,
      [institutionId, priceListId, productId, priceTag, aliqProfit ?? null, aliqKickback ?? null, quantity ?? null, deleted]
    )

    await conn.commit()
    res.json(syncSuccess(productId))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /price/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
