import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Unidade de Medida — catálogo CENTRAL (D5): dedupe por descrição (D17) em
 * setes_central.tb_measure + vínculo tb_institution_has_measure. Id local
 * (MED_CODIGO) descartado. Endpoint NOVO — não existia na setes-sync
 * (gap achado na Onda 3). Contrato: CONTRATOS_SYNC.md.
 */
const measureBody = z.object({
  description:  z.string().trim().min(1).max(100),
  abbreviation: z.string().trim().max(5).nullable().optional(),
  escale:       z.number().nullable().optional(),
  deleted:      z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /measure/sincronize:
 *   post:
 *     summary: Sincronizar Unidade de Medida (catálogo central + vínculo)
 *     description: >-
 *       Dedupe por descrição em setes_central.tb_measure (D5/D17) e vínculo
 *       em tb_institution_has_measure do schema do cliente. Atributos
 *       (abbreviation/escale) só entram na CRIAÇÃO da linha central — reuso
 *       não sobrescreve o catálogo compartilhado.
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
 *               description: { type: string, example: "UNIDADE" }
 *               abbreviation: { type: string, example: "UND" }
 *               escale: { type: number, example: 1 }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id } — id do catálogo central" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao processar }
 */
router.post('/measure/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = measureBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { description, abbreviation, escale, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    const { id } = await ensureCatalogItem(conn, 'tb_measure', description, {
      abbreviation: abbreviation ?? null,
      escale:       escale ?? null,
    })
    await conn.query(`USE \`${schemaName}\``)
    await upsertCatalogLink(conn, 'tb_institution_has_measure', 'tb_measure_id',
      institutionId, id, { active: deleted === 'S' ? 'N' : 'S' })
    await conn.commit()

    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields })
      return
    }
    logger.error('Erro em /measure/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
