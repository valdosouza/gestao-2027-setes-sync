import { Request, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import logger from '@shared/logger/logger'

/**
 * Log CENTRAL de respostas de erro dos endpoints /sincronize (2026-07-27,
 * diagnóstico da 1ª rodada real do Sincronizador): os endpoints respondem
 * HttpError (400/409/422) SEM logar — o detalhe do "Payload inválido"
 * (array `fields` com o campo exato) só viajava no corpo HTTP, que o
 * Delphi descarta (SRC_LOG guarda apenas a mensagem). Este middleware
 * intercepta o res.json: toda resposta >= 400 vira (a) WARN no console e
 * (b) linha JSONL em logs/sync-errors.log — com endpoint, status, code,
 * fields, id/terminal e, nos 400, o payload compactado (strings longas
 * truncadas — ex.: contentBase64 do /filexml).
 */

const LOG_DIR  = path.resolve(process.cwd(), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'sync-errors.log')
fs.mkdirSync(LOG_DIR, { recursive: true })

function compactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body
  const clone: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    clone[k] = typeof v === 'string' && v.length > 200
      ? `${v.slice(0, 200)}…(${v.length} chars)`
      : v
  }
  return clone
}

export function syncErrorLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.toLowerCase().includes('sincronize')) return next()

  const originalJson = res.json.bind(res)
  res.json = ((payload: any) => {
    if (res.statusCode >= 400) {
      const entry = {
        ts:          new Date().toISOString(),
        endpoint:    `${req.method} ${req.path}`,
        status:      res.statusCode,
        error:       payload?.error,
        code:        payload?.code,
        fields:      payload?.fields,
        id:          (req.body as any)?.id,
        terminal:    (req.body as any)?.terminal,
        institution: req.syncClient?.institutionId,
        // payload completo só nos 400 (é onde o campo exato importa)
        payload:     res.statusCode === 400 ? compactBody(req.body) : undefined,
      }
      logger.warn(`Sync ${res.statusCode} em ${req.path}`, entry)
      fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => { /* log nunca derruba a resposta */ })
    }
    return originalJson(payload)
  }) as typeof res.json

  next()
}
