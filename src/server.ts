import app from './app'
import logger from '@shared/logger/logger'

const PORT = process.env.PORT ?? 3001

app.listen(PORT, () => {
  logger.info(`Setes Sync API rodando na porta ${PORT}`)
})
