import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Embalagem — catálogo CENTRAL (D5): dedupe por descrição (D17) em
 * setes_central.tb_package + vínculo tb_institution_has_package. Id local
 * (EMB_CODIGO) descartado. Corrige o bug legado do Delphi que fixava
 * active='S' (agora deleted do payload desativa o vínculo — D2).
 * Contrato: CONTRATOS_SYNC.md.
 */
const packageBody = z.object({
  description:  z.string().trim().min(1).max(100),
  abbreviation: z.string().trim().max(3).nullable().optional(),
  deleted:      z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /package/sincronize:
 *   post:
 *     summary: Sincronizar Embalagem (catálogo central + vínculo)
 *     description: >-
 *       Dedupe por descrição em setes_central.tb_package (D5/D17) e vínculo
 *       em tb_institution_has_package do schema do cliente. deleted='S'
 *       desativa o vínculo (a linha central fica).
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
 *               description: { type: string, example: "CAIXA" }
 *               abbreviation: { type: string, example: "CX" }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id } — id do catálogo central" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao processar }
 */
router.post('/package/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = packageBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { description, abbreviation, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    const { id } = await ensureCatalogItem(conn, 'tb_package', description, {
      abbreviation: abbreviation ?? null,
    })
    await conn.query(`USE \`${schemaName}\``)
    await upsertCatalogLink(conn, 'tb_institution_has_package', 'tb_package_id',
      institutionId, id, { active: deleted === 'S' ? 'N' : 'S' })
    await conn.commit()

    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields })
      return
    }
    logger.error('Erro em /package/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
