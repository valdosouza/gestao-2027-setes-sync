import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Tabela de Preço — ID LOCAL ✅ (MAPA_INDEXACAO #6): TPR_CODIGO do Firebird
 * É o id na web (tb_price_list, PK id+institution). Upsert simples; campos
 * espelham as colunas reais do DDL (validity/modality/aliq_profit/published).
 * deleted='S' = soft delete (D2). Contrato: CONTRATOS_SYNC.md.
 */
const priceListBody = z.object({
  id:          z.number().int().positive(),
  description: z.string().trim().min(1).max(45),
  validity:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data no formato YYYY-MM-DD').optional().nullable(),
  modality:    z.string().trim().max(1).optional().nullable(),
  aliqProfit:  z.number().optional().nullable(),
  published:   z.enum(['S', 'N']).optional().default('S'),
  deleted:     z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /price-list/sincronize:
 *   post:
 *     summary: Sincronizar Tabela de Preço (id local)
 *     description: >-
 *       Upsert em tb_price_list do schema do cliente com id = TPR_CODIGO do
 *       Firebird (PK id+institution). deleted='S' = soft delete.
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
 *               id: { type: integer, example: 3 }
 *               description: { type: string, example: "VAREJO" }
 *               validity: { type: string, format: date, example: "2026-12-31" }
 *               modality: { type: string, maxLength: 1 }
 *               aliqProfit: { type: number, example: 30 }
 *               published: { type: string, enum: [S, N] }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao processar }
 */
router.post('/price-list/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = priceListBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, description, validity, modality, aliqProfit, published, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    await conn.query(
      `INSERT INTO tb_price_list
         (id, tb_institution_id, description, validity, modality, aliq_profit, published, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         description = VALUES(description), validity = VALUES(validity),
         modality = VALUES(modality), aliq_profit = VALUES(aliq_profit),
         published = VALUES(published), deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, description, validity ?? null, modality ?? null, aliqProfit ?? null, published, deleted]
    )

    await conn.commit()
    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /price-list/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
