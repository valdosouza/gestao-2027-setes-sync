import { Request, Response, NextFunction } from 'express'
import pool   from '@shared/db/connection'
import logger from '@shared/logger/logger'

// Decisão D12 (prompt_revisao_sincronizador_setes_sync.md): UMA API key por
// instalação/cliente em setes_central.tb_sync_api_key. institutionId + schemaName
// resolvidos aqui via JOIN em tb_institution (fonte única do schema_name).
export interface SyncClient {
  institutionId:     number
  establishmentCode: string
  schemaName:        string
}

declare global {
  namespace Express {
    interface Request {
      syncClient?: SyncClient
    }
  }
}

/**
 * Recusas de autenticação (D-SY13, Valdo 2026-10-18): o Sincronizador que
 * recebe a recusa PARA a sincronia sem marcar o SRC_LOG e fica INATIVO até o
 * usuário ativar manualmente (consulta em GET /sync-key/status).
 *   SYNC_KEY_MISSING  401 — header ausente
 *   SYNC_KEY_INVALID  401 — chave inexistente (ou apagada)
 *   SYNC_KEY_INACTIVE 403 — chave EXISTENTE e inativa (active = 'N')
 * A-SY1 (a ratificar pelo Valdo): o Sincronizador trata o 401 com o mesmo
 * efeito do 403 — a chave inexistente também deixa a sincronia inativa.
 */
export const SYNC_KEY_CODES = {
  MISSING:  'SYNC_KEY_MISSING',
  INVALID:  'SYNC_KEY_INVALID',
  INACTIVE: 'SYNC_KEY_INACTIVE',
} as const

export type ApiKeyLookup =
  | { status: 'active';   client: SyncClient }
  | { status: 'inactive' }
  | { status: 'invalid' }

// Cache simples em memoria com TTL de 5 minutos — SÓ da chave válida (o negativo
// nunca é guardado). LIMITE CONHECIDO (D-SY13 item 4): desativar a chave vale em
// até 5 min para o processo que já a tinha em cache; a consulta do estado
// (GET /sync-key/status) lê sempre o banco e acerta o cache.
const keyCache = new Map<string, { client: SyncClient; expiresAt: number }>()
const TTL = 5 * 60 * 1000

/** Lê o estado da chave NO BANCO (sem cache). Chave apagada (deleted='S') = inexistente. */
export async function lookupApiKey(apiKey: string): Promise<ApiKeyLookup> {
  const [rows] = await pool.query<any[]>(
    `SELECT sak.tb_institution_id, sak.establishment_code, sak.active, i.schema_name
     FROM setes_central.tb_sync_api_key sak
     JOIN setes_central.tb_institution i ON i.id = sak.tb_institution_id
     WHERE sak.api_key = ? AND sak.deleted = 'N'`,
    [apiKey]
  )
  if (!rows.length) return { status: 'invalid' }
  // mais de uma linha viva com a mesma chave: vale a ativa, se houver
  const live = rows.find(r => r.active === 'S')
  if (!live) return { status: 'inactive' }
  return {
    status: 'active',
    client: {
      institutionId:     live.tb_institution_id,
      establishmentCode: live.establishment_code,
      schemaName:        live.schema_name,
    },
  }
}

/** Lê do banco e acerta o cache (ativa = guarda; inativa/inexistente = esquece). */
export async function refreshApiKey(apiKey: string): Promise<ApiKeyLookup> {
  const result = await lookupApiKey(apiKey)
  if (result.status === 'active') keyCache.set(apiKey, { client: result.client, expiresAt: Date.now() + TTL })
  else keyCache.delete(apiKey)
  return result
}

async function resolveApiKey(apiKey: string): Promise<ApiKeyLookup> {
  const cached = keyCache.get(apiKey)
  if (cached && cached.expiresAt > Date.now()) return { status: 'active', client: cached.client }
  return refreshApiKey(apiKey)
}

/** Resposta de recusa — a MESMA no middleware e na consulta do estado. */
export function sendKeyRefusal(res: Response, apiKey: string | undefined, status: 'missing' | 'invalid' | 'inactive'): void {
  const masked = apiKey ? apiKey.slice(0, 8) + '...' : ''
  if (status === 'missing') {
    res.status(401).json({ ok: false, error: 'X-Api-Key header obrigatorio', code: SYNC_KEY_CODES.MISSING })
  } else if (status === 'inactive') {
    logger.warn('API Key INATIVA — sincronizador recusado (D-SY13)', { apiKey: masked })
    res.status(403).json({ ok: false, error: 'API Key inativa', code: SYNC_KEY_CODES.INACTIVE })
  } else {
    logger.warn('API Key invalida', { apiKey: masked })
    res.status(401).json({ ok: false, error: 'API Key invalida', code: SYNC_KEY_CODES.INVALID })
  }
}

export function syncAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string

  if (!apiKey) {
    sendKeyRefusal(res, undefined, 'missing')
    return
  }

  resolveApiKey(apiKey)
    .then(result => {
      if (result.status !== 'active') {
        sendKeyRefusal(res, apiKey, result.status)
        return
      }
      req.syncClient = result.client
      next()
    })
    .catch(() => res.status(500).json({ ok: false, error: 'Erro ao validar API Key' }))
}
