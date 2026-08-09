import rateLimit from 'express-rate-limit'

export const rateLimitMiddleware = rateLimit({
  windowMs: 60 * 1000, // 60 segundos
  // Carga HISTÓRICA do Sincronizador = 1 request por registro — 500/min
  // derrubou 246 notas na 1ª rodada real (2026-07-27). Ajustável por env.
  max: Number(process.env.SYNC_RATE_LIMIT_PER_MIN ?? 5000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de requisições excedido. Tente novamente em 1 minuto.' },
})
