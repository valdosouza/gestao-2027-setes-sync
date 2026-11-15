import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import logger from '@shared/logger/logger'
dotenv.config()

/**
 * D-TZ4 (Valdo 2026-09-30, prompt_pesquisa_avancada.md §10.3): o setes-sync adota a
 * MESMA regra do setes-api (D-TZ1) — INSTANTES em UTC. O driver serializa/lê
 * DATETIME/TIMESTAMP em UTC ('Z') e TEM que concordar com o `SET time_zone =
 * '+00:00'` da sessão (sem isso um Date JS gravaria a hora de SP como se fosse UTC).
 * Datas de negócio do Delphi chegam como 'YYYY-MM-DD' (o fuso não as toca); hora de
 * parede do legado vira instante pela zona do estabelecimento (@shared/time-zone).
 * Dado gravado antes da troca = data de corte (D-TZ3, sem backfill).
 */
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 20,
  timezone: 'Z',
})

export const SESSION_TIME_ZONE = '+00:00'

/**
 * Fixa o fuso de toda conexão NOVA do pool (inclusive reconexão). O evento entrega a
 * conexão CRUA (estilo callback, apesar do tipo promise): o erro vem no callback e
 * não pode passar em silêncio (L1 do gate da onda TZ-1 da API).
 */
export function fixSessionTimeZone(conn: unknown): void {
  const raw = conn as { query: (sql: string, cb: (err: unknown) => void) => void }
  raw.query(`SET time_zone = '${SESSION_TIME_ZONE}'`, err => {
    if (err) logger.error(`Conexão nova sem time_zone '${SESSION_TIME_ZONE}' — invariante da casa violada (D-TZ4)`, { err })
  })
}

pool.on('connection', fixSessionTimeZone)

/** D-TZ4: confere no boot que a sessão está em UTC — senão o serviço não sobe. */
export async function assertSessionTimeZoneUtc(): Promise<string> {
  const [rows] = await pool.query<any[]>(`SELECT @@session.time_zone AS tz`)
  const tz = String(rows[0]?.tz ?? '')
  if (tz !== SESSION_TIME_ZONE) {
    throw new Error(`Fuso da sessão do banco é ${tz || 'desconhecido'} — a casa exige '${SESSION_TIME_ZONE}' (D-TZ4)`)
  }
  return tz
}

export async function getConnection(schemaName: string) {
  const conn = await pool.getConnection()
  await conn.query(`USE \`${schemaName}\``)
  return conn
}

export default pool
