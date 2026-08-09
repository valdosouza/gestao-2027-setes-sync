import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { snFlag } from '@shared/validation'

const router = Router()

/**
 * Produto de SERVIÇO — decisão D2 do prompt_notas_mercadoria_servico.md
 * (2026-07-26): PRO_TIPO='S' sincroniza por AQUI e grava SOMENTE tb_product
 * com kind='S' — serviço não tem especialização (sem tb_merchandise, sem
 * tb_stock; a peça de serviço nasce quando a web emitir NFS-e nativa).
 * ID LOCAL ✅ (MAPA_INDEXACAO #5, mesmo espaço de id do /merchandise:
 * PRO_CODIGO É o id — o produto é UM só, a natureza é o kind).
 * Categoria por id local — 409 CATEGORY_NOT_SYNCED.
 * deleted='S' = soft delete. Contrato: CONTRATOS_SYNC.md.
 */
const serviceProductBlock = z.object({
  description:      z.string().trim().min(1).max(100),
  categoryId:       z.number().int().positive(),
  identifier:       z.string().trim().max(50).optional(),
  financialPlansId: z.number().int().positive().nullish(),
  promotion:        snFlag('N'),
  highlights:       snFlag('N'),
  active:           snFlag('S'),
  published:        snFlag('N'),
  note:             z.string().optional(),
})

const serviceBody = z.object({
  id:      z.number().int().positive(),
  deleted: z.enum(['S', 'N']).optional().default('N'),
  product: serviceProductBlock,
})

/**
 * @swagger
 * /service/sincronize:
 *   post:
 *     summary: Sincronizar Produto de Serviço (tb_product kind='S', id local)
 *     description: >-
 *       Upsert SOMENTE em tb_product do schema do cliente com id = PRO_CODIGO
 *       do Firebird e kind='S' (decisão D2 — serviço não tem tb_merchandise
 *       nem tb_stock). Categoria por id local — inexistente = 409
 *       CATEGORY_NOT_SYNCED (reenvio no próximo ciclo). deleted='S' = soft
 *       delete. Mercadorias (PRO_TIPO P/M) usam o /merchandise/sincronize.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, product]
 *             properties:
 *               id: { type: integer, example: 501, description: PRO_CODIGO do Firebird }
 *               deleted: { type: string, enum: [S, N] }
 *               product:
 *                 type: object
 *                 required: [description, categoryId]
 *                 properties:
 *                   description: { type: string, example: "TROCA DE OLEO" }
 *                   categoryId: { type: integer, example: 12 }
 *                   identifier: { type: string, example: "SRV-001" }
 *                   financialPlansId: { type: integer, nullable: true }
 *                   promotion: { type: string, enum: [S, N] }
 *                   highlights: { type: string, enum: [S, N] }
 *                   active: { type: string, enum: [S, N] }
 *                   published: { type: string, enum: [S, N] }
 *                   note: { type: string }
 *     responses:
 *       200: { description: "{ ok, id } — id = PRO_CODIGO" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Categoria ainda não sincronizada — reenviar depois }
 *       500: { description: Erro ao processar }
 */
router.post('/service/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = serviceBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, deleted, product } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    // Categoria por id local — precisa já ter sido sincronizada
    const [cats] = await conn.query<any[]>(
      `SELECT id FROM tb_category
       WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' LIMIT 1`,
      [product.categoryId, institutionId]
    )
    if (!cats.length) {
      throw new HttpError(409, `Categoria ${product.categoryId} ainda não sincronizada`,
        [{ field: 'product.categoryId', message: 'sincronize a categoria antes — reenvio no próximo ciclo' }],
        'CATEGORY_NOT_SYNCED')
    }

    // ── tb_product (PK id + tb_institution_id) — kind='S' sempre ─────────
    const [exProduct] = await conn.query<any[]>(
      `SELECT id FROM tb_product WHERE id = ? AND tb_institution_id = ? LIMIT 1 FOR UPDATE`,
      [id, institutionId]
    )
    const productValues = [
      product.identifier ?? '0', product.description, product.categoryId,
      product.financialPlansId ?? null, product.promotion, product.highlights,
      product.active, product.published, product.note ?? null, deleted,
    ]
    if (exProduct.length) {
      await conn.query(
        `UPDATE tb_product
         SET identifier = ?, description = ?, tb_category_id = ?, tb_financial_plans_id = ?,
             promotion = ?, highlights = ?, active = ?, published = ?, note = ?, deleted = ?,
             kind = 'S', updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [...productValues, id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_product
           (id, tb_institution_id, kind, identifier, description, tb_category_id, tb_financial_plans_id,
            promotion, highlights, active, published, note, deleted, created_at, updated_at)
         VALUES (?, ?, 'S', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, institutionId, ...productValues]
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
    logger.error('Erro em /service/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
