import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { AddressInput, AddressRow } from './address.types'

/**
 * Persistência de ENDEREÇOS (tb_address, setes_central — PK id+kind).
 * Peça independente (SRP): só conhece a própria tabela; o vínculo com a
 * entity é o [entityId] recebido por parâmetro. Escrita é TRANSACTION-AWARE
 * (conn da transação aberta pelo chamador).
 */

/** Diff por kind: upsert dos enviados, deleted='S' nos ausentes (nunca DELETE). */
export async function syncAddresses(
  conn: PoolConnection, entityId: number, addresses: AddressInput[],
  updatedBy: number | null = null
): Promise<void> {
  for (const a of addresses) {
    await conn.query(
      `INSERT INTO setes_central.tb_address
         (id, kind, street, nmbr, complement, neighborhood, zip_code,
          tb_country_id, tb_state_id, tb_city_id, main, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?)
       ON DUPLICATE KEY UPDATE
         street = VALUES(street), nmbr = VALUES(nmbr), complement = VALUES(complement),
         neighborhood = VALUES(neighborhood), zip_code = VALUES(zip_code),
         tb_country_id = VALUES(tb_country_id), tb_state_id = VALUES(tb_state_id),
         tb_city_id = VALUES(tb_city_id), main = VALUES(main),
         deleted = 'N', updated_at = NOW(), updated_by = VALUES(updated_by)`,
      [entityId, a.kind, a.street, a.nmbr ?? 'sn', a.complement ?? null,
       a.neighborhood ?? null, a.zipCode ?? null, a.tbCountryId, a.tbStateId,
       a.tbCityId, a.main ?? 'S', updatedBy]
    )
  }
  const kinds = addresses.map(a => a.kind)
  if (kinds.length > 0) {
    await conn.query(
      `UPDATE setes_central.tb_address SET deleted = 'S', updated_at = NOW(), updated_by = ?
       WHERE id = ? AND kind NOT IN (?)`,
      [updatedBy, entityId, kinds]
    )
  } else {
    await conn.query(
      `UPDATE setes_central.tb_address SET deleted = 'S', updated_at = NOW(), updated_by = ? WHERE id = ?`,
      [updatedBy, entityId]
    )
  }
}

/** Endereços vivos da entity, com nomes de país/UF/cidade via JOIN. */
export async function listAddresses(entityId: number): Promise<AddressRow[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT a.kind, a.street, a.nmbr, a.complement, a.neighborhood,
            a.zip_code      AS zipCode,
            a.tb_country_id AS tbCountryId,
            a.tb_state_id   AS tbStateId,
            a.tb_city_id    AS tbCityId,
            a.main,
            co.name         AS countryName,
            st.name         AS stateName,
            ci.name         AS cityName
     FROM setes_central.tb_address a
     LEFT JOIN setes_central.tb_country co ON co.id = a.tb_country_id
     LEFT JOIN setes_central.tb_state   st ON st.id = a.tb_state_id
     LEFT JOIN setes_central.tb_city    ci ON ci.id = a.tb_city_id
     WHERE a.id = ? AND a.deleted = 'N'
     ORDER BY a.kind`,
    [entityId]
  )
  return rows as AddressRow[]
}
