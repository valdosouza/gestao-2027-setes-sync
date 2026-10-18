import { Router, Request, Response } from 'express'
import { refreshApiKey, sendKeyRefusal } from '../sync.auth.middleware'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Estado da chave do Sincronizador (D-SY13, Valdo 2026-10-18): o
 * Sincronizador que recebeu a recusa da chave fica INATIVO e só volta quando o
 * usuário clica em "Ativar sincronia" — o botão consulta AQUI: ativa = limpa o
 * estado e retoma; inativa/inexistente = nada acontece.
 *
 * Fica FORA do syncAuthMiddleware de propósito: lê o banco SEM o cache de 5 min
 * da chave válida (refreshApiKey) e acerta o cache — a consulta nunca responde
 * "ativa" para uma chave que acabou de ser desativada. As recusas são as MESMAS
 * do middleware (401 SYNC_KEY_MISSING/SYNC_KEY_INVALID, 403 SYNC_KEY_INACTIVE).
 * Não devolve institution nem schema (a resposta não precisa expor o cliente).
 */

/**
 * @swagger
 * /sync-key/status:
 *   get:
 *     summary: Estado da chave do Sincronizador (botão "Ativar sincronia" — D-SY13)
 *     description: >-
 *       Lê a chave do header X-Api-Key direto no banco (sem o cache de 5 min do
 *       middleware) e acerta o cache. 200 = chave ativa — o Sincronizador limpa
 *       o estado "sincronia inativa" e retoma. 403 SYNC_KEY_INACTIVE = a chave
 *       existe e segue inativa; 401 = chave ausente ou inexistente — nos dois o
 *       Sincronizador continua inativo.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200:
 *         description: "{ ok: true, active: true }"
 *       401: { description: "SYNC_KEY_MISSING (header ausente) ou SYNC_KEY_INVALID (chave inexistente)" }
 *       403: { description: "SYNC_KEY_INACTIVE — a chave existe e está inativa" }
 *       500: { description: Erro ao validar a chave }
 */
router.get('/sync-key/status', async (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'] as string | undefined
  if (!apiKey) {
    sendKeyRefusal(res, undefined, 'missing')
    return
  }
  try {
    const result = await refreshApiKey(apiKey)
    if (result.status !== 'active') {
      sendKeyRefusal(res, apiKey, result.status)
      return
    }
    res.json({ ok: true, active: true })
  } catch (err: any) {
    logger.error('Erro em /sync-key/status', { message: err?.message })
    res.status(500).json({ ok: false, error: 'Erro ao validar API Key' })
  }
})

export default router
