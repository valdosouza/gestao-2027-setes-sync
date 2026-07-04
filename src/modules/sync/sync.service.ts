import { upsertRecords, getUpdatedRecords, writeSyncLog } from './sync.repository'
import { enqueue } from './sync.queue'
import logger from '@shared/logger/logger'

export interface PushPayload {
  table:   string
  records: Record<string, any>[]
}

export interface PullQuery {
  table: string
  since: string
  limit?: number
}

export async function processPush(
  schemaName:        string,
  establishmentCode: string,
  payload:           PushPayload
): Promise<{ inserted: number; updated: number; queued: boolean }> {
  const start = Date.now()

  // Lotes pequenos (<= 50): processa direto
  // Lotes grandes (> 50): enfileira e responde aceito
  const isLarge = payload.records.length > 50

  try {
    let result: { inserted: number; updated: number }

    if (isLarge) {
      enqueue({
        schemaName,
        establishmentCode,
        tableName: payload.table,
        records:   payload.records,
      }).then(() => {
        writeSyncLog({
          establishmentCode,
          schemaName,
          direction:    'push',
          tableName:    payload.table,
          recordsCount: payload.records.length,
          status:       'success',
          durationMs:   Date.now() - start,
        })
      }).catch(err => {
        writeSyncLog({
          establishmentCode,
          schemaName,
          direction:    'push',
          tableName:    payload.table,
          recordsCount: payload.records.length,
          status:       'error',
          errorMessage: err.message,
        })
      })

      return { inserted: 0, updated: 0, queued: true }
    }

    result = await upsertRecords(schemaName, payload.table, payload.records)

    await writeSyncLog({
      establishmentCode,
      schemaName,
      direction:    'push',
      tableName:    payload.table,
      recordsCount: payload.records.length,
      status:       'success',
      durationMs:   Date.now() - start,
    })

    logger.info('Push processado', {
      establishmentCode,
      table:    payload.table,
      ...result,
    })

    return { ...result, queued: false }

  } catch (err: any) {
    await writeSyncLog({
      establishmentCode,
      schemaName,
      direction:    'push',
      tableName:    payload.table,
      recordsCount: payload.records.length,
      status:       'error',
      errorMessage: err.message,
    })
    throw err
  }
}

export async function processPull(
  schemaName:        string,
  establishmentCode: string,
  query:             PullQuery
): Promise<{ records: Record<string, any>[]; count: number }> {
  const start = Date.now()

  try {
    const records = await getUpdatedRecords(
      schemaName,
      query.table,
      query.since,
      query.limit ?? 500
    )

    await writeSyncLog({
      establishmentCode,
      schemaName,
      direction:    'pull',
      tableName:    query.table,
      recordsCount: records.length,
      status:       'success',
      durationMs:   Date.now() - start,
    })

    logger.info('Pull processado', {
      establishmentCode,
      table: query.table,
      count: records.length,
    })

    return { records, count: records.length }

  } catch (err: any) {
    await writeSyncLog({
      establishmentCode,
      schemaName,
      direction:    'pull',
      tableName:    query.table,
      recordsCount: 0,
      status:       'error',
      errorMessage: err.message,
    })
    throw err
  }
}
