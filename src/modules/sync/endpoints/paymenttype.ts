import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Forma de Pagamento — catálogo CENTRAL (D5): dedupe por descrição (D17) em
 * setes_central.tb_payment_types + vínculo tb_institution_has_payment_types
 * no schema do cliente, COM atributos próprios (enable, app_mobile, tef...).
 * Id local do Firebird é DESCARTADO (MAPA_INDEXACAO). id_nfce entra só na
 * CRIAÇÃO da linha central (reuso nunca sobrescreve o catálogo dos outros).
 * Atributo AUSENTE no payload não entra no upsert do vínculo — configuração
 * já feita pelo cliente na web não é clobberada. Soft delete (D2):
 * deleted='S' desabilita o vínculo (enable='N'); a linha central fica.
 * institution vem da API key (D12). Contrato: CONTRATOS_SYNC.md.
 */
const paymentTypeBody = z.object({
  description:              z.string().trim().min(1).max(45),
  idNfce:                   z.string().regex(/^\d{2}$/, 'id_nfce da NFC-e tem 2 dígitos').optional(),
  enable:                   z.enum(['S', 'N']).optional(),
  appMobile:                z.enum(['S', 'N']).optional(),
  blockForCustomerBlocked:  z.enum(['S', 'N']).optional(),
  blockForCustomerNoLimit:  z.enum(['S', 'N']).optional(),
  maxParcels:               z.number().int().min(1).optional(),
  tef:                      z.enum(['S', 'N']).optional(),
  deleted:                  z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /payment-type/sincronize:
 *   post:
 *     summary: Sincronizar Forma de Pagamento (catálogo central + vínculo com atributos)
 *     description: >-
 *       Dedupe por descrição em setes_central.tb_payment_types (D5/D17) e
 *       vínculo em tb_institution_has_payment_types do schema do cliente
 *       (resolvido pela X-Api-Key). idNfce só é gravado na CRIAÇÃO da linha
 *       central. Atributos do vínculo (enable, appMobile, tef...) só são
 *       atualizados quando presentes no payload. deleted='S' desabilita o
 *       vínculo (enable='N'); a linha central fica.
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
 *               description: { type: string, example: "CARTAO CREDITO" }
 *               idNfce: { type: string, example: "03", description: "Código NFC-e (2 dígitos) — usado só na criação" }
 *               enable: { type: string, enum: [S, N] }
 *               appMobile: { type: string, enum: [S, N] }
 *               blockForCustomerBlocked: { type: string, enum: [S, N] }
 *               blockForCustomerNoLimit: { type: string, enum: [S, N] }
 *               maxParcels: { type: integer, example: 12 }
 *               tef: { type: string, enum: [S, N] }
 *               deleted: { type: string, enum: [S, N], example: "N" }
 *     responses:
 *       200:
 *         description: "{ ok, id } — id do catálogo central"
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao processar }
 */
router.post('/payment-type/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = paymentTypeBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const {
      description, idNfce, enable, appMobile, blockForCustomerBlocked,
      blockForCustomerNoLimit, maxParcels, tef, deleted,
    } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    const { id } = await ensureCatalogItem(conn, 'tb_payment_types', description,
      { id_nfce: idNfce ?? null })

    // Atributos do VÍNCULO: só o que veio no payload (não clobbera config web)
    const attrs: Record<string, string | number> = {}
    if (enable !== undefined)                  attrs.enable = enable
    if (appMobile !== undefined)               attrs.app_mobile = appMobile
    if (blockForCustomerBlocked !== undefined) attrs.block_for_customer_blocked = blockForCustomerBlocked
    if (blockForCustomerNoLimit !== undefined) attrs.block_for_customer_no_limit = blockForCustomerNoLimit
    if (maxParcels !== undefined)              attrs.max_parcels = maxParcels
    if (tef !== undefined)                     attrs.tef = tef
    if (deleted === 'S')                       attrs.enable = 'N' // soft delete desabilita o vínculo

    await conn.query(`USE \`${schemaName}\``)
    await upsertCatalogLink(conn, 'tb_institution_has_payment_types', 'tb_payment_types_id',
      institutionId, id, attrs)
    await conn.commit()

    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields })
      return
    }
    logger.error('Erro em /payment-type/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
