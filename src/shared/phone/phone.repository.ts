import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { PhoneInput, PhoneRow } from './phone.types'

/**
 * Persistência de FONES (tb_phone, setes_central — SINGULAR; PK id+kind).
 * Peça independente (SRP): só conhece a própria tabela; o vínculo com a
 * entity é o [entityId] recebido por parâmetro. Escrita é TRANSACTION-AWARE
 * (conn da transação aberta pelo chamador).
 */

/** Diff por kind: upsert dos enviados, deleted='S' nos ausentes (nunca DELETE). */
export async function syncPhones(
  conn: PoolConnection, entityId: number, phones: PhoneInput[],
  updatedBy: number | null = null
): Promise<void> {
  for (const p of phones) {
    await conn.query(
      `INSERT INTO setes_central.tb_phone (id, kind, contact, number, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, NOW(), NOW(), ?)
       ON DUPLICATE KEY UPDATE
         contact = VALUES(contact), number = VALUES(number),
         deleted = 'N', updated_at = NOW(), updated_by = VALUES(updated_by)`,
      [entityId, p.kind, p.contact ?? null, p.number ?? null, updatedBy]
    )
  }
  const kinds = phones.map(p => p.kind)
  if (kinds.length > 0) {
    await conn.query(
      `UPDATE setes_central.tb_phone SET deleted = 'S', updated_at = NOW(), updated_by = ?
       WHERE id = ? AND kind NOT IN (?)`,
      [updatedBy, entityId, kinds]
    )
  } else {
    await conn.query(
      `UPDATE setes_central.tb_phone SET deleted = 'S', updated_at = NOW(), updated_by = ? WHERE id = ?`,
      [updatedBy, entityId]
    )
  }
}

/** Fones vivos da entity. */
export async function listPhones(entityId: number): Promise<PhoneRow[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT kind, contact, number
     FROM setes_central.tb_phone WHERE id = ? AND deleted = 'N' ORDER BY kind`,
    [entityId]
  )
  return rows as PhoneRow[]
}
