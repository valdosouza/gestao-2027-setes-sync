import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Marca — catálogo CENTRAL (D5): dedupe por descrição (D17) em
 * setes_central.tb_brand + vínculo tb_institution_has_brand no schema do
 * cliente. Id local do Firebird (MRC_CODIGO) é DESCARTADO (MAPA_INDEXACAO).
 * institution vem da API key (D12); soft delete (D2) desativa o VÍNCULO.
 * Contrato: Infra-IA/setes-sync/CONTRATOS_SYNC.md.
 */
const brandBody = z.object({
  description: z.string().trim().min(1).max(100),
  deleted:     z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /brand/sincronize:
 *   post:
 *     summary: Sincronizar Marca (catálogo central + vínculo)
 *     description: >-
 *       Dedupe por descrição em setes_central.tb_brand (D5/D17) e vínculo
 *       em tb_institution_has_brand do schema do cliente (resolvido pela
 *       X-Api-Key). deleted='S' desativa o vínculo (a linha central fica).
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description]
 *             properties:
 *               description: { type: string, example: "NIKE" }
 *               deleted: { type: string, enum: [S, N], example: "N" }
 *     responses:
 *       200:
 *         description: "{ ok, id } — id do catálogo central"
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao processar }
 */
router.post('/brand/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = brandBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { description, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    const { id } = await ensureCatalogItem(conn, 'tb_brand', description)
    await conn.query(`USE \`${schemaName}\``)
    await upsertCatalogLink(conn, 'tb_institution_has_brand', 'tb_brand_id',
      institutionId, id, { active: deleted === 'S' ? 'N' : 'S' })
    await conn.commit()

    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields })
      return
    }
    logger.error('Erro em /brand/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
