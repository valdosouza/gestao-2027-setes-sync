const logger = {
  info: (msg: string, meta?: object) =>
    console.log(`[INFO]  ${new Date().toISOString()} ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: object) =>
    console.warn(`[WARN]  ${new Date().toISOString()} ${msg}`, meta ?? ''),
  error: (msg: string, meta?: object) =>
    console.error(`[ERROR] ${new Date().toISOString()} ${msg}`, meta ?? ''),
}

export default logger
