import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { syncSuccess, syncError } from '../sync.response'
import { ensureAndLinkCatalogItem } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Marca — catálogo CENTRAL (D5): dedupe por descrição (D17) em
 * setes_central.tb_brand + vínculo tb_institution_has_brand no schema do
 * cliente. Id local do Firebird (MRC_CODIGO) é DESCARTADO (MAPA_INDEXACAO).
 * institution vem da API key (D12); soft delete (D2) desativa o VÍNCULO.
 * Serializado pela trava nomeada `setes_central.tb_brand` — a mesma do
 * setes-api (D-SY10, PADROES_BANCO §9 regra 11; ensureAndLinkCatalogItem).
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
 *       401: { description: "X-Api-Key inexistente ou ausente (SYNC_KEY_INVALID / SYNC_KEY_MISSING)" }
 *       403: { description: "Chave existente e INATIVA (SYNC_KEY_INACTIVE — D-SY13)" }
 *       409: { description: "RESOURCE_BUSY — trava do catálogo central ocupada por mais de 10 s; reenviar" }
 *       500: { description: Erro ao processar }
 */
router.post('/brand/sincronize', async (req: Request, res: Response) => {
  try {
    const parsed = brandBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { description, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    const { id } = await ensureAndLinkCatalogItem('tb_brand', schemaName, institutionId,
      { description }, { active: deleted === 'S' ? 'N' : 'S' })

    res.json(syncSuccess(id))
  } catch (err: any) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /brand/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  }
})

export default router
