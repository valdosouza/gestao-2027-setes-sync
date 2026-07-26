import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { syncEntityBody, saveSyncEntity, stripDocumentMasks } from '../sync.entity'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Fornecedor — papel de entidade (Onda 4): cadeia na central pelo motor
 * (reindexação D3/D4) + papel tb_provider no schema do cliente com
 * id = entity.id (D13). Contrato: CONTRATOS_SYNC.md (bloco entity padrão
 * + bloco provider).
 */
const providerBody = z.object({
  active: z.enum(['S', 'N']).optional().default('S'),
})

/**
 * @swagger
 * /provider/sincronize:
 *   post:
 *     summary: Sincronizar Fornecedor (cadeia central + papel no schema)
 *     description: >-
 *       Bloco entity padrão reindexado por CPF/CNPJ ou externalCode +
 *       bloco provider. Devolve externalCode quando personType='N'.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id, externalCode?, clearExternalCode? } — id = entity.id" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       404: { description: externalCode desconhecido }
 *       500: { description: Erro ao processar }
 */
router.post('/provider/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const entityParsed = syncEntityBody.safeParse(stripDocumentMasks(req.body))
    if (!entityParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco entity)',
        entityParsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const provParsed = providerBody.safeParse(req.body.provider ?? {})
    if (!provParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco provider)',
        provParsed.error.issues.map(i => ({ field: `provider.${i.path.join('.')}`, message: i.message })))
    }
    const deleted: 'S' | 'N' = req.body.deleted === 'S' ? 'S' : 'N'
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    const { entityId, externalCode, clearExternalCode } =
      await saveSyncEntity(conn, entityParsed.data, { origin: 'provider', institutionId })

    await conn.query(`USE \`${schemaName}\``)
    await conn.query(
      `INSERT INTO tb_provider (id, tb_institution_id, active, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         active = VALUES(active), deleted = VALUES(deleted), updated_at = NOW()`,
      [entityId, institutionId, provParsed.data.active, deleted]
    )

    await conn.commit()
    res.json(syncSuccess(entityId, externalCode, clearExternalCode))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /provider/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
