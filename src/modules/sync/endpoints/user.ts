import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { syncEntityBody, saveSyncEntity, stripDocumentMasks } from '../sync.entity'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Usuário do legado (TB_USUARIO) — autor das operações
 * (prompt_indexacao_usuario_firebird.md). Cadeia na central pelo motor
 * (D3/D4) + tb_user SEM credencial (decisão 1: password NULL, active='N' —
 * nunca loga; se um dia a pessoa virar usuária web real, é a MESMA
 * entity/linha) + vínculo tb_institution_has_user com kind='SYNC'
 * (decisão 3 — a origem fica marcada para a tela de usuários).
 * NÃO-INVASÃO (decisão 4): se a entity JÁ tem tb_user real (senha
 * definida), nada de credencial é tocado — só o vínculo é garantido; e o
 * active/deleted do vínculo só é atualizado quando o vínculo nasceu do
 * sync (kind='SYNC'). USU_ATIVO do legado → active do VÍNCULO; deleted →
 * deleted do VÍNCULO, nunca da entity (decisão 7 — ex-funcionário
 * sincroniza: o histórico de pedidos precisa dele).
 * Contrato: CONTRATOS_SYNC.md.
 */
const userBody = z.object({
  active: z.enum(['S', 'N']).optional().default('S'),
})

/**
 * @swagger
 * /user/sincronize:
 *   post:
 *     summary: Sincronizar Usuário do legado (cadeia central + tb_user sem credencial)
 *     description: >-
 *       Bloco entity padrão reindexado por CPF/CNPJ ou externalCode + bloco
 *       user { active } (USU_ATIVO → active do vínculo institution×user).
 *       Cria tb_user sem credencial (password NULL, active='N') quando não
 *       existe; NUNCA toca credencial de usuário web real. Vínculo
 *       tb_institution_has_user nasce com kind='SYNC'. Devolve externalCode
 *       quando personType='N'. Deve sincronizar ANTES dos movimentos que
 *       referenciam o autor (order-sale/purchase/stock-adjust, cashier,
 *       financial-statement).
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id, externalCode?, clearExternalCode? } — id = entity.id = tb_user.id" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       404: { description: externalCode desconhecido }
 *       500: { description: Erro ao processar }
 */
router.post('/user/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const entityParsed = syncEntityBody.safeParse(stripDocumentMasks(req.body))
    if (!entityParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco entity)',
        entityParsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const userParsed = userBody.safeParse(req.body.user ?? {})
    if (!userParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco user)',
        userParsed.error.issues.map(i => ({ field: `user.${i.path.join('.')}`, message: i.message })))
    }
    const deleted: 'S' | 'N' = req.body.deleted === 'S' ? 'S' : 'N'
    const { institutionId } = req.syncClient!

    await conn.beginTransaction()
    const { entityId, externalCode, clearExternalCode } =
      await saveSyncEntity(conn, entityParsed.data, { origin: 'user', institutionId })

    // tb_user: cria SEM credencial se não existe; existente fica intocado
    // (decisão 4 — inclusive um deleted='S' antigo não é ressuscitado aqui).
    const [users] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_user WHERE id = ? LIMIT 1 FOR UPDATE`,
      [entityId]
    )
    if (!users.length) {
      await conn.query(
        `INSERT INTO setes_central.tb_user
           (id, password, active, activation_key, created_at, updated_at, deleted)
         VALUES (?, NULL, 'N', NULL, NOW(), NOW(), 'N')`,
        [entityId]
      )
    }

    // Vínculo institution×user: kind='SYNC' na criação; num vínculo
    // pré-existente de usuário web real (kind <> 'SYNC') o sync não mexe
    // em active/deleted (decisão 4).
    await conn.query(
      `INSERT INTO setes_central.tb_institution_has_user
         (tb_institution_id, tb_user_id, kind, active, created_at, updated_at, deleted)
       VALUES (?, ?, 'SYNC', ?, NOW(), NOW(), ?)
       ON DUPLICATE KEY UPDATE
         active  = IF(kind = 'SYNC', VALUES(active),  active),
         deleted = IF(kind = 'SYNC', VALUES(deleted), deleted),
         updated_at = NOW()`,
      [institutionId, entityId, userParsed.data.active, deleted]
    )

    await conn.commit()
    res.json(syncSuccess(entityId, externalCode, clearExternalCode))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /user/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
