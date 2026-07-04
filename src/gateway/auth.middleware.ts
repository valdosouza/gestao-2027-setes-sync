import { Request, Response, NextFunction } from 'express'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = req.headers['x-api-key'] as string
    if (!apiKey) {
      throw new HttpError(401, 'X-Api-Key ausente')
    }

    const validKey = process.env.SYNC_API_KEY
    if (apiKey !== validKey) {
      throw new HttpError(401, 'X-Api-Key inválida')
    }

    req.syncContext = {
      apiKey,
      timestamp: new Date(),
    }

    logger.info('Sincronizador autenticado', { timestamp: new Date().toISOString() })
    next()
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message })
    } else {
      res.status(401).json({ error: 'Erro ao validar X-Api-Key' })
    }
  }
}
