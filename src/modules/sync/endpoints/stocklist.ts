import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Lista de Estoque — ID LOCAL ✅ (MAPA_INDEXACAO #8): ETS_CODIGO do Firebird
 * É o id na web (tb_stock_list, PK id+institution). O legado mapeava
 * ETS_PRINCIPAL como "Tipo" — aqui a coluna real é `main` ('S'/'N').
 * deleted='S' = soft delete (D2). Contrato: CONTRATOS_SYNC.md.
 */
const stockListBody = z.object({
  id:          z.number().int().positive(),
  description: z.string().trim().min(1).max(45),
  main:        z.enum(['S', 'N']).optional().default('N'),
  active:      z.enum(['S', 'N']).optional().default('S'),
  kind:        z.string().trim().max(1).optional().nullable(),
  terminal:    z.number().int().optional().nullable(),
  deleted:     z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /stock-list/sincronize:
 *   post:
 *     summary: Sincronizar Lista de Estoque (id local)
 *     description: >-
 *       Upsert em tb_stock_list do schema do cliente com id = ETS_CODIGO do
 *       Firebird (PK id+institution). main = estoque principal ('S'/'N').
 *       deleted='S' = soft delete.
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
 *               id: { type: integer, example: 1 }
 *               description: { type: string, example: "ESTOQUE GERAL" }
 *               main: { type: string, enum: [S, N] }
 *               active: { type: string, enum: [S, N] }
 *               kind: { type: string, maxLength: 1 }
 *               terminal: { type: integer, example: 0 }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao processar }
 */
router.post('/stock-list/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = stockListBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, description, main, active, kind, terminal, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    await conn.query(
      `INSERT INTO tb_stock_list
         (id, tb_institution_id, description, main, active, kind, terminal, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         description = VALUES(description), main = VALUES(main),
         active = VALUES(active), kind = VALUES(kind),
         terminal = VALUES(terminal), deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, description, main, active, kind ?? null, terminal ?? 0, deleted]
    )

    await conn.commit()
    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /stock-list/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
