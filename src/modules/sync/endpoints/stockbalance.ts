import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Saldo de Estoque — chave COMPOSTA (MAPA_INDEXACAO #9): o alvo real no DDL
 * é a tabela própria tb_stock_balance, PK (tb_institution_id,
 * tb_stock_list_id, tb_merchandise_id) — e NÃO tb_stock.quantity, que não
 * tem a dimensão da lista de estoque. stockListId e merchandiseId são ids
 * locais do Firebird (ETS_CODIGO / PRO_CODIGO). Lista ou mercadoria ainda
 * não sincronizadas → 409 (o Sincronizador reenvia no próximo ciclo).
 * deleted='S' = soft delete (D2). Contrato: CONTRATOS_SYNC.md.
 */
const stockBalanceBody = z.object({
  stockListId:   z.number().int().positive(),
  merchandiseId: z.number().int().positive(),
  quantity:      z.number(),
  minimum:       z.number().optional().nullable(),
  deleted:       z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /stock-balance/sincronize:
 *   post:
 *     summary: Sincronizar Saldo de Estoque (chave composta lista+mercadoria)
 *     description: >-
 *       Upsert em tb_stock_balance do schema do cliente pela PK
 *       (institution, stockListId, merchandiseId) — ids locais do Firebird.
 *       Lista de estoque ou mercadoria inexistentes = 409 (reenvio no
 *       próximo ciclo). Produto kind 'S' (serviço) = 200 sem gravar —
 *       serviço não tem estoque na web. deleted='S' = soft delete.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [stockListId, merchandiseId, quantity]
 *             properties:
 *               stockListId: { type: integer, example: 1 }
 *               merchandiseId: { type: integer, example: 152 }
 *               quantity: { type: number, example: 42.5 }
 *               minimum: { type: number, example: 5 }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id } (id = merchandiseId)" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Lista de estoque ou mercadoria ainda não sincronizadas }
 *       500: { description: Erro ao processar }
 */
router.post('/stock-balance/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = stockBalanceBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { stockListId, merchandiseId, quantity, minimum, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    const [lists] = await conn.query<any[]>(
      `SELECT id FROM tb_stock_list WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
      [stockListId, institutionId]
    )
    if (!lists.length) {
      throw new HttpError(409, `Lista de estoque ${stockListId} ainda não sincronizada`,
        [{ field: 'stockListId', message: 'sincronize a lista de estoque antes — reenvio no próximo ciclo' }],
        'STOCK_LIST_NOT_SYNCED')
    }

    // Produto SERVIÇO não tem estoque na web (kind 'S' — sem tb_merchandise/
    // tb_stock por definição), mas o legado cria TB_ESTOQUE para todo produto
    // e o Sincronizador envia o saldo. Sem este desvio o envio ficaria em 409
    // MERCHANDISE_NOT_SYNCED ETERNO (serviço nunca terá mercadoria). Decisão
    // Valdo 2026-08-14: responder 200 sem gravar — a fila marca OK e limpa.
    const [services] = await conn.query<any[]>(
      `SELECT id FROM tb_product WHERE id = ? AND tb_institution_id = ? AND kind = 'S' LIMIT 1`,
      [merchandiseId, institutionId]
    )
    if (services.length) {
      await conn.rollback()
      res.json(syncSuccess(merchandiseId))
      return
    }

    const [merchandises] = await conn.query<any[]>(
      `SELECT id FROM tb_merchandise WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
      [merchandiseId, institutionId]
    )
    if (!merchandises.length) {
      throw new HttpError(409, `Mercadoria ${merchandiseId} ainda não sincronizada`,
        [{ field: 'merchandiseId', message: 'sincronize o produto antes — reenvio no próximo ciclo' }],
        'MERCHANDISE_NOT_SYNCED')
    }

    await conn.query(
      `INSERT INTO tb_stock_balance
         (tb_institution_id, tb_stock_list_id, tb_merchandise_id, quantity, minimum, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         quantity = VALUES(quantity), minimum = VALUES(minimum),
         deleted = VALUES(deleted), updated_at = NOW()`,
      [institutionId, stockListId, merchandiseId, quantity, minimum ?? null, deleted]
    )

    await conn.commit()
    res.json(syncSuccess(merchandiseId))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /stock-balance/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
