import express from 'express'
import swaggerUi from 'swagger-ui-express'
import dotenv from 'dotenv'
dotenv.config()

import { rateLimitMiddleware } from '@gateway/rate-limit.middleware'
import { syncErrorLogMiddleware } from '@gateway/sync-error-log.middleware'
import syncSpecificRoutes from '@modules/sync/sync.specific.routes'
import testSyncRoutes from '@modules/test/test-sync.routes'
import logger from '@shared/logger/logger'
import { swaggerSpec } from '@shared/swagger/swagger-config'

const app = express()

app.use(express.json())

// Swagger documentation
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))
app.get('/docs.json', (_, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.send(swaggerSpec)
})

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health Check
 *     description: Verifica se a API está rodando
 *     security: []
 *     tags:
 *       - Health
 *     responses:
 *       200:
 *         description: API está saudável
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HealthResponse'
 */
app.get('/health', (_, res) =>
  res.json({ status: 'ok', service: 'setes-sync', ts: new Date().toISOString() })
)

// Rotas de teste do Sincronizador (System de testes incremental)
// Ex: GET /api/test/dependency-map, POST /api/test/sessions, etc.
app.use('/api/test', testSyncRoutes)

// Rotas específicas do Sincronizador Delphi
// Ex: POST /brand/sincronize, POST /customer/sincronize, etc.
// Auth (X-Api-Key) é validado dentro de sync.specific.routes via syncAuthMiddleware
app.use(rateLimitMiddleware)
// Log central de respostas >= 400 dos /sincronize (console + logs/sync-errors.log)
// — os endpoints respondem HttpError sem logar; o detalhe (fields) morreria aqui.
app.use(syncErrorLogMiddleware)
app.use('/', syncSpecificRoutes)

// Handler global de erros
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Erro nao tratado', { message: err.message })
    res.status(500).json({ error: 'Erro interno do servidor' })
  }
)

export default app
