import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { userRefBody, resolveUserId } from '../sync.user'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Caixa — id local ✅ (id do caixa no Firebird; PK id+institution+terminal).
 * AUTOR (prompt_indexacao_usuario_firebird.md, decisão 6): bloco `user`
 * opcional (userDocument OU userExternalCode) resolve tb_userid = entity.id
 * do usuário do legado (409 USER_NOT_SYNCED); ausente → NULL (comportamento
 * anterior — o código local nunca viaja, D3). Reenvio COM bloco corrige o
 * autor. O contrato antigo com `items` (tb_cashier_items) foi REMOVIDO
 * deste endpoint — fechamento por forma de pagamento entra em endpoint
 * próprio quando a onda de movimento financeiro o definir.
 * Contrato: CONTRATOS_SYNC.md.
 */
const DATETIME_RX = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/

const cashierBody = z.object({
  id:       z.number().int().positive(),
  terminal: z.number().int().min(0),
  dtRecord: z.string().regex(DATETIME_RX),
  hrBegin:  z.string().regex(DATETIME_RX).nullable().optional(),
  hrEnd:    z.string().regex(DATETIME_RX).nullable().optional(),
  deleted:  z.enum(['S', 'N']).optional().default('N'),
  user:     userRefBody.optional(),
})

/**
 * @swagger
 * /cashier/sincronize:
 *   post:
 *     summary: Sincronizar Caixa (id local)
 *     description: >-
 *       Upsert em tb_cashier com id local do Firebird (PK id+institution+
 *       terminal). Bloco `user` opcional (userDocument OU userExternalCode)
 *       resolve o autor (409 USER_NOT_SYNCED); ausente → tb_userid NULL.
 *       Datas em YYYY-MM-DD[ HH:MM[:SS]].
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, dtRecord]
 *             properties:
 *               id: { type: integer, example: 91 }
 *               terminal: { type: integer, example: 1 }
 *               dtRecord: { type: string, example: "2026-07-19" }
 *               hrBegin: { type: string, example: "2026-07-19 08:00:00" }
 *               hrEnd: { type: string, example: "2026-07-19 18:12:00" }
 *               deleted: { type: string, enum: [S, N] }
 *               user:
 *                 type: object
 *                 description: Autor do caixa — exatamente UM dos campos (ausente = NULL)
 *                 properties:
 *                   userDocument: { type: string, example: "52998224725" }
 *                   userExternalCode: { type: string, format: uuid }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao processar }
 */
router.post('/cashier/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = cashierBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const b = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // Autor (decisão 6) — resolve na central ANTES do USE
    const userId = b.user ? await resolveUserId(conn, b.user, institutionId) : null

    await conn.query(`USE \`${schemaName}\``)

    await conn.query(
      `INSERT INTO tb_cashier
         (id, tb_institution_id, terminal, dt_record, tb_userid,
          hr_begin, hr_end, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         ${b.user ? 'tb_userid = VALUES(tb_userid),' : ''}
         dt_record = VALUES(dt_record), hr_begin = VALUES(hr_begin),
         hr_end = VALUES(hr_end), deleted = VALUES(deleted), updated_at = NOW()`,
      // tb_userid só atualiza quando o bloco `user` veio (decisão 5).
      [b.id, institutionId, b.terminal, b.dtRecord, userId,
       b.hrBegin ?? null, b.hrEnd ?? null, b.deleted]
    )

    await conn.commit()
    res.json(syncSuccess(b.id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /cashier/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
