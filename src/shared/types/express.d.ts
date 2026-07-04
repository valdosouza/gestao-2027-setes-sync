import { Request } from 'express'

export interface SyncContext {
  apiKey: string
  timestamp: Date
}

declare global {
  namespace Express {
    interface Request {
      syncContext?: SyncContext
    }
  }
}
