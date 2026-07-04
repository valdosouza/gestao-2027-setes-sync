import { PoolConnection } from 'mysql2/promise'

export async function nextId(
  conn: PoolConnection,
  tableName: string,
  institutionId: number
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id
     FROM \`${tableName}\`
     WHERE tb_institution_id = ?
     FOR UPDATE`,
    [institutionId]
  )
  return rows[0].next_id
}

export async function nextGlobalId(
  conn: PoolConnection,
  tableName: string
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM \`${tableName}\` FOR UPDATE`
  )
  return rows[0].next_id
}
