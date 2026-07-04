import express from 'express'
import swaggerUi from 'swagger-ui-express'
import dotenv from 'dotenv'
dotenv.config()

import { rateLimitMiddleware } from '@gateway/rate-limit.middleware'
import syncSpecificRoutes from '@modules/sync/sync.specific.routes'
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

// Rotas específicas do Sincronizador Delphi
// Ex: POST /brand/sincronize, POST /customer/sincronize, etc.
// Auth (X-Api-Key) é validado dentro de sync.specific.routes via syncAuthMiddleware
app.use(rateLimitMiddleware)
app.use('/', syncSpecificRoutes)

// Handler global de erros
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Erro nao tratado', { message: err.message })
    res.status(500).json({ error: 'Erro interno do servidor' })
  }
)

export default app
