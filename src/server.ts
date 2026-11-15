import app from './app'
import logger from '@shared/logger/logger'
import { assertSessionTimeZoneUtc } from '@shared/db/connection'

const PORT = process.env.PORT ?? 3001

async function bootstrap() {
  // D-TZ4: instantes em UTC, como o setes-api — sessão fora de UTC não sobe (dado misto)
  logger.info(`Fuso da sessão do banco: ${await assertSessionTimeZoneUtc()}`)
  app.listen(PORT, () => {
    logger.info(`Setes Sync API rodando na porta ${PORT}`)
  })
}

bootstrap().catch(err => {
  logger.error('Falha no boot do setes-sync', { err: err instanceof Error ? err.message : err })
  process.exit(1)
})
