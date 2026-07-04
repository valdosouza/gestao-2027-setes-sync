import { PoolConnection } from 'mysql2/promise'
import { nextGlobalId, nextId } from './sync.id-generator'

export async function findOrCreateByDescription(
  conn: PoolConnection,
  tableName: string,
  description: string,
  institutionId?: number
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM \`${tableName}\` WHERE description = ? LIMIT 1`,
    [description]
  )
  if (rows.length) return rows[0].id

  const newId = institutionId
    ? await nextId(conn, tableName, institutionId)
    : await nextGlobalId(conn, tableName)

  await conn.query(
    `INSERT INTO \`${tableName}\` (id, description, created_at, updated_at)
     VALUES (?, ?, NOW(), NOW())`,
    [newId, description]
  )
  return newId
}

export async function findPaymentTypeByDescription(
  conn: PoolConnection,
  description: string,
  institutionId: number
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM tb_payment_types WHERE description = ? LIMIT 1`,
    [description || 'CARTEIRA']
  )
  if (rows.length) return rows[0].id

  return findOrCreateByDescription(conn, 'tb_payment_types', description || 'CARTEIRA')
}

export async function findBankByNumber(
  conn: PoolConnection,
  bankNumber: string
): Promise<number | null> {
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM tb_bank WHERE number = ? LIMIT 1`,
    [bankNumber]
  )
  return rows.length ? rows[0].id : null
}
