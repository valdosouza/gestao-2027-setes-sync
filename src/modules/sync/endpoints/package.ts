import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { syncSuccess, syncError } from '../sync.response'
import { ensureAndLinkCatalogItem } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Embalagem — catálogo CENTRAL (D5): dedupe por descrição (D17) em
 * setes_central.tb_package + vínculo tb_institution_has_package. Id local
 * (EMB_CODIGO) descartado. Corrige o bug legado do Delphi que fixava
 * active='S' (agora deleted do payload desativa o vínculo — D2).
 * Serializado pela trava nomeada `setes_central.tb_package` — a mesma do
 * setes-api (D-SY10, PADROES_BANCO §9 regra 11; ensureAndLinkCatalogItem);
 * a abreviação é atributo gravado só na criação.
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
 *       401: { description: "X-Api-Key inexistente ou ausente (SYNC_KEY_INVALID / SYNC_KEY_MISSING)" }
 *       403: { description: "Chave existente e INATIVA (SYNC_KEY_INACTIVE — D-SY13)" }
 *       409: { description: "RESOURCE_BUSY — trava do catálogo central ocupada por mais de 10 s; reenviar" }
 *       500: { description: Erro ao processar }
 */
router.post('/package/sincronize', async (req: Request, res: Response) => {
  try {
    const parsed = packageBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { description, abbreviation, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    const { id } = await ensureAndLinkCatalogItem('tb_package', schemaName, institutionId,
      { description, abbreviation: abbreviation ?? null }, { active: deleted === 'S' ? 'N' : 'S' })

    res.json(syncSuccess(id))
  } catch (err: any) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /package/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  }
})

export default router
