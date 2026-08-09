import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { AddressInput, AddressRow } from './address.types'

/**
 * Persistência de ENDEREÇOS (tb_address, setes_central — PK id+kind).
 * Peça independente (SRP): só conhece a própria tabela; o vínculo com a
 * entity é o [entityId] recebido por parâmetro. Escrita é TRANSACTION-AWARE
 * (conn da transação aberta pelo chamador).
 */

/**
 * Referências geográficas do endereço (1ª rodada real 2026-07-27: a FK de
 * tb_state_id estourava em 500 — a referência central estava quase vazia).
 * País/estado inexistentes = 409 legível (COUNTRY/STATE_NOT_FOUND — estados
 * têm seed dos 27 IBGE); CIDADE inexistente é AUTO-CRIADA com nome
 * placeholder (ids de cidade são os do legado — enriquecer nome/IBGE depois;
 * indexação multi-cliente por IBGE é pendência da Rodada 4).
 */
async function ensureAddressRefs(conn: PoolConnection, a: AddressInput): Promise<void> {
  const [countries] = await conn.query<any[]>(
    `SELECT id FROM setes_central.tb_country WHERE id = ? LIMIT 1`, [a.tbCountryId])
  if (!countries.length) {
    throw new HttpError(409, `País ${a.tbCountryId} não existe na referência central`,
      [{ field: 'addresses.tbCountryId', message: 'cadastre o país na central e reenvie' }],
      'COUNTRY_NOT_FOUND')
  }
  const [states] = await conn.query<any[]>(
    `SELECT id FROM setes_central.tb_state WHERE id = ? LIMIT 1`, [a.tbStateId])
  if (!states.length) {
    throw new HttpError(409, `Estado ${a.tbStateId} não existe na referência central`,
      [{ field: 'addresses.tbStateId', message: 'cadastre o estado (IBGE) na central e reenvie' }],
      'STATE_NOT_FOUND')
  }
  const [cities] = await conn.query<any[]>(
    `SELECT id FROM setes_central.tb_city WHERE id = ? LIMIT 1`, [a.tbCityId])
  if (!cities.length) {
    logger.warn(`tb_city ${a.tbCityId} auto-criada (placeholder) para o endereço do legado`)
    await conn.query(
      `INSERT INTO setes_central.tb_city (id, tb_state_id, name, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [a.tbCityId, a.tbStateId, `CIDADE ${a.tbCityId} (legado — enriquecer)`]
    )
  }
}

/** Diff por kind: upsert dos enviados, deleted='S' nos ausentes (nunca DELETE). */
export async function syncAddresses(
  conn: PoolConnection, entityId: number, addresses: AddressInput[],
  updatedBy: number | null = null
): Promise<void> {
  for (const a of addresses) {
    await ensureAddressRefs(conn, a)
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
