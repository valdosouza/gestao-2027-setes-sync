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

// Cache simples em memoria com TTL de 5 minutos
const keyCache = new Map<string, { client: SyncClient; expiresAt: number }>()
const TTL = 5 * 60 * 1000

async function resolveApiKey(apiKey: string): Promise<SyncClient | null> {
  const now    = Date.now()
  const cached = keyCache.get(apiKey)
  if (cached && cached.expiresAt > now) return cached.client

  const [rows] = await pool.query<any[]>(
    `SELECT sak.tb_institution_id, sak.establishment_code, i.schema_name
     FROM setes_central.tb_sync_api_key sak
     JOIN setes_central.tb_institution i ON i.id = sak.tb_institution_id
     WHERE sak.api_key = ? AND sak.active = 'S' AND sak.deleted = 'N'`,
    [apiKey]
  )

  if (!rows.length) return null

  const client: SyncClient = {
    institutionId:     rows[0].tb_institution_id,
    establishmentCode: rows[0].establishment_code,
    schemaName:        rows[0].schema_name,
  }

  keyCache.set(apiKey, { client, expiresAt: now + TTL })
  return client
}

export function syncAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string

  if (!apiKey) {
    res.status(401).json({ ok: false, error: 'X-Api-Key header obrigatorio' })
    return
  }

  resolveApiKey(apiKey)
    .then(client => {
      if (!client) {
        logger.warn('API Key invalida ou inativa', { apiKey: apiKey.slice(0, 8) + '...' })
        res.status(401).json({ ok: false, error: 'API Key invalida' })
        return
      }
      req.syncClient = client
      next()
    })
    .catch(() => res.status(500).json({ ok: false, error: 'Erro ao validar API Key' }))
}
