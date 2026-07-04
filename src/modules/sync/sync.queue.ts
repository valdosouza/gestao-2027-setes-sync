import logger from '@shared/logger/logger'
import { upsertRecords } from './sync.repository'

interface QueueJob {
  schemaName:        string
  establishmentCode: string
  tableName:         string
  records:           Record<string, any>[]
  resolve:           (result: any) => void
  reject:            (err: Error)  => void
}

const queue: QueueJob[] = []
let processing = false

async function processNext() {
  if (processing || queue.length === 0) return
  processing = true

  const job = queue.shift()!

  try {
    const result = await upsertRecords(job.schemaName, job.tableName, job.records)
    job.resolve(result)
  } catch (err) {
    logger.error('Erro no processamento da fila de sync', { err, schemaName: job.schemaName })
    job.reject(err as Error)
  } finally {
    processing = false
    if (queue.length > 0) setImmediate(processNext)
  }
}

export function enqueue(job: Omit<QueueJob, 'resolve' | 'reject'>): Promise<any> {
  return new Promise((resolve, reject) => {
    queue.push({ ...job, resolve, reject })
    setImmediate(processNext)
  })
}

export function getQueueStatus() {
  return { pending: queue.length, processing }
}
