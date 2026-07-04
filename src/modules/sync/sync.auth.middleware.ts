import { Request, Response, NextFunction } from 'express'
import pool   from '@shared/db/connection'
import logger from '@shared/logger/logger'

export interface SyncClient {
  establishmentCode: string
  tenantId:          string
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
    `SELECT establishment_code, tenant_id, schema_name
     FROM setes_central.sync_api_keys
     WHERE api_key = ? AND active = TRUE`,
    [apiKey]
  )

  if (!rows.length) return null

  const client: SyncClient = {
    establishmentCode: rows[0].establishment_code,
    tenantId:          rows[0].tenant_id,
    schemaName:        rows[0].schema_name,
  }

  keyCache.set(apiKey, { client, expiresAt: now + TTL })
  return client
}

export function syncAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'] as string

  if (!apiKey) {
    res.status(401).json({ error: 'X-Api-Key header obrigatorio' })
    return
  }

  resolveApiKey(apiKey)
    .then(client => {
      if (!client) {
        logger.warn('API Key invalida ou inativa', { apiKey: apiKey.slice(0, 8) + '...' })
        res.status(401).json({ error: 'API Key invalida' })
        return
      }
      req.syncClient = client
      next()
    })
    .catch(() => res.status(500).json({ error: 'Erro ao validar API Key' }))
}
