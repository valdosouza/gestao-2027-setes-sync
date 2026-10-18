import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { syncSuccess, syncError } from '../sync.response'
import { ensureAndLinkCatalogItem } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Unidade de Medida — catálogo CENTRAL (D5) em setes_central.tb_measure +
 * vínculo tb_institution_has_measure. Id local (MED_CODIGO) descartado.
 * Contrato: CONTRATOS_SYNC.md.
 *
 * CHAVE = ABREVIAÇÃO (D-SY10 = D-PR39, Valdo 2026-10-18): a medida é ÚNICA na
 * central e a busca pela abreviação unifica o cadastro de todos os clientes —
 * a MESMA sistemática do setes-api (UPPER(TRIM) binário + trava nomeada
 * `setes_central.tb_measure`). A descrição e a escala são atributos gravados
 * só na CRIAÇÃO (reuso não sobrescreve o catálogo compartilhado).
 * A abreviação é OBRIGATÓRIA no contrato (o campo tem de vir); medida do
 * legado com MED_ABREVIATURA vazia/nula resolve pela DESCRIÇÃO, como antes,
 * com aviso no log. O legado guarda no máximo 5 (VARCHAR(5), domínio
 * "Descricao_5") — a coluna central de 6 (D-PR35) comporta.
 */
export const measureBody = z.object({
  description:  z.string().trim().min(1).max(100),
  abbreviation: z.string().trim().max(5).nullable(),
  escale:       z.number().nullable().optional(),
  deleted:      z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /measure/sincronize:
 *   post:
 *     summary: Sincronizar Unidade de Medida (catálogo central + vínculo)
 *     description: >-
 *       Dedupe pela ABREVIAÇÃO (D-SY10) em setes_central.tb_measure — a mesma
 *       chave e a mesma trava nomeada do setes-api — e vínculo em
 *       tb_institution_has_measure do schema do cliente. abbreviation é
 *       obrigatória no payload; vazia/nula (medida do legado sem abreviação)
 *       resolve pela descrição, com aviso no log. description/escale só entram
 *       na CRIAÇÃO da linha central — reuso não sobrescreve o catálogo
 *       compartilhado. deleted='S' desativa o vínculo (a linha central fica).
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [description, abbreviation]
 *             properties:
 *               description: { type: string, example: "UNIDADE" }
 *               abbreviation: { type: string, nullable: true, maxLength: 5, example: "UND", description: "Chave do dedupe (MED_ABREVIATURA); vazia = resolve pela descrição" }
 *               escale: { type: number, example: 1 }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id } — id do catálogo central" }
 *       400: { description: Payload inválido (inclusive sem o campo abbreviation) }
 *       401: { description: "X-Api-Key inexistente ou ausente (SYNC_KEY_INVALID / SYNC_KEY_MISSING)" }
 *       403: { description: "Chave existente e INATIVA (SYNC_KEY_INACTIVE — D-SY13)" }
 *       409: { description: "RESOURCE_BUSY — trava do catálogo central ocupada por mais de 10 s; reenviar" }
 *       500: { description: Erro ao processar }
 */
router.post('/measure/sincronize', async (req: Request, res: Response) => {
  try {
    const parsed = measureBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { description, abbreviation, escale, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    const { id } = await ensureAndLinkCatalogItem('tb_measure', schemaName, institutionId,
      { description, abbreviation, extras: { escale: escale ?? null } },
      { active: deleted === 'S' ? 'N' : 'S' })

    res.json(syncSuccess(id))
  } catch (err: any) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /measure/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  }
})

export default router
