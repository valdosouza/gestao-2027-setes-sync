import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { syncEntityBody, saveSyncEntity, stripDocumentMasks } from '../sync.entity'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Vendedor/Colaborador — papel de entidade (Onda 4). PRECEDÊNCIA
 * OBRIGATÓRIA (PADROES_BANCO §2, Valdo 2026-07-17): Salesman SEMPRE é
 * Collaborator — este endpoint grava tb_collaborator E tb_salesman na
 * mesma transação (herança em dois níveis, mesmo id = entity.id).
 * Cadeia na central pelo motor (D3/D4). O legado descartava colaborador
 * sem e-mail (ValidaSendSalesman) — aqui e-mail é OPCIONAL (mailings).
 * Contrato: CONTRATOS_SYNC.md.
 */
const collaboratorBody = z.object({
  active:              z.enum(['S', 'N']).optional().default('S'),
  dtAdmission:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  dtResignation:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  salary:              z.number().nullable().optional(),
  fathersName:         z.string().max(100).nullable().optional(),
  mothersName:         z.string().max(100).nullable().optional(),
  voteNumber:          z.string().max(20).nullable().optional(),
  voteZone:            z.string().max(10).nullable().optional(),
  voteSection:         z.string().max(10).nullable().optional(),
  militaryCertificate: z.string().max(30).nullable().optional(),
  pis:                 z.string().max(20).nullable().optional(),
})

const salesmanBody = z.object({
  active:          z.enum(['S', 'N']).optional().default('S'),
  aliqKickback:    z.number().nullable().optional(),
  kickbackProduct: z.string().max(1).nullable().optional(),
  flexValue:       z.number().optional().default(0),
})

/**
 * @swagger
 * /salesman/sincronize:
 *   post:
 *     summary: Sincronizar Vendedor (cadeia central + collaborator + salesman)
 *     description: >-
 *       Bloco entity padrão + bloco collaborator + bloco salesman.
 *       Precedência Collaborator→Salesman garantida na transação (todo
 *       vendedor É colaborador). Bloco salesman ausente = sincroniza só o
 *       colaborador. Devolve externalCode quando personType='N'.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id, externalCode? } — id = entity.id" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       404: { description: externalCode desconhecido }
 *       500: { description: Erro ao processar }
 */
router.post('/salesman/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const entityParsed = syncEntityBody.safeParse(stripDocumentMasks(req.body))
    if (!entityParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco entity)',
        entityParsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const collabParsed = collaboratorBody.safeParse(req.body.collaborator ?? {})
    if (!collabParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco collaborator)',
        collabParsed.error.issues.map(i => ({ field: `collaborator.${i.path.join('.')}`, message: i.message })))
    }
    const salesParsed = salesmanBody.safeParse(req.body.salesman ?? {})
    if (!salesParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco salesman)',
        salesParsed.error.issues.map(i => ({ field: `salesman.${i.path.join('.')}`, message: i.message })))
    }
    const collab = collabParsed.data
    const sales  = salesParsed.data
    const hasSalesman = req.body.salesman !== undefined
    const deleted: 'S' | 'N' = req.body.deleted === 'S' ? 'S' : 'N'
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    const { entityId, externalCode } = await saveSyncEntity(conn, entityParsed.data)

    await conn.query(`USE \`${schemaName}\``)

    // Precedência: Collaborator SEMPRE (mesmo quando só o vendedor mudou)
    await conn.query(
      `INSERT INTO tb_collaborator
         (id, tb_institution_id, active, dt_admission, dt_resignation, salary,
          fathers_name, mothers_name, vote_number, vote_zone, vote_section,
          military_certificate, pis, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         active = VALUES(active), dt_admission = VALUES(dt_admission),
         dt_resignation = VALUES(dt_resignation), salary = VALUES(salary),
         fathers_name = VALUES(fathers_name), mothers_name = VALUES(mothers_name),
         vote_number = VALUES(vote_number), vote_zone = VALUES(vote_zone),
         vote_section = VALUES(vote_section),
         military_certificate = VALUES(military_certificate), pis = VALUES(pis),
         deleted = VALUES(deleted), updated_at = NOW()`,
      [entityId, institutionId, collab.active, collab.dtAdmission ?? null,
       collab.dtResignation ?? null, collab.salary ?? null, collab.fathersName ?? null,
       collab.mothersName ?? null, collab.voteNumber ?? null, collab.voteZone ?? null,
       collab.voteSection ?? null, collab.militaryCertificate ?? null,
       collab.pis ?? null, deleted]
    )

    if (hasSalesman) {
      await conn.query(
        `INSERT INTO tb_salesman
           (id, tb_institution_id, active, aliq_kickback, kickback_product,
            flex_value, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           active = VALUES(active), aliq_kickback = VALUES(aliq_kickback),
           kickback_product = VALUES(kickback_product), flex_value = VALUES(flex_value),
           deleted = VALUES(deleted), updated_at = NOW()`,
        [entityId, institutionId, sales.active, sales.aliqKickback ?? null,
         sales.kickbackProduct ?? null, sales.flexValue, deleted]
      )
    }

    await conn.commit()
    res.json(syncSuccess(entityId, externalCode))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /salesman/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
