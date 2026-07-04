import rateLimit from 'express-rate-limit'

export const rateLimitMiddleware = rateLimit({
  windowMs: 60 * 1000, // 60 segundos
  max: 500, // Sincronizador pode enviar mais dados
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de requisições excedido. Tente novamente em 1 minuto.' },
})
