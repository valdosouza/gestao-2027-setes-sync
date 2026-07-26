import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { EntityInput, EntityRow } from './entity.types'

/**
 * Persistência da ENTITY BASE (tb_entity, setes_central) — SÓ tb_entity
 * (SRP). Escrita é TRANSACTION-AWARE (conn da transação do chamador).
 * A composição da cadeia (entity + fiscal + listas) vive em entity-fiscal.ts.
 */

/** id = MAX+1 em tb_entity com FOR UPDATE (decisão 7 da Fase 2). */
export async function nextEntityId(conn: PoolConnection): Promise<number> {
  const [rows] = await conn.query<any[]>(
    'SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_entity FOR UPDATE'
  )
  return Number(rows[0].nextId)
}

export async function insertEntity(
  conn: PoolConnection, id: number, input: EntityInput,
  updatedBy: number | null = null
): Promise<void> {
  await conn.query(
    `INSERT INTO setes_central.tb_entity
       (id, name_company, nick_trade, aniversary, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, NOW(), NOW(), ?)`,
    [id, input.nameCompany, input.nickTrade, input.aniversary ?? null, updatedBy]
  )
}

export async function updateEntity(
  conn: PoolConnection, id: number, input: EntityInput,
  updatedBy: number | null = null
): Promise<void> {
  await conn.query(
    `UPDATE setes_central.tb_entity
     SET name_company = ?, nick_trade = ?, aniversary = ?, updated_at = NOW(), updated_by = ?
     WHERE id = ?`,
    [input.nameCompany, input.nickTrade, input.aniversary ?? null, updatedBy, id]
  )
}

/** Campos base da entity (null se não existe). Datas com DATE_FORMAT. */
export async function getEntityBase(id: number): Promise<EntityRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT e.name_company AS nameCompany,
            e.nick_trade   AS nickTrade,
            DATE_FORMAT(e.aniversary, '%Y-%m-%d') AS aniversary
     FROM setes_central.tb_entity e
     WHERE e.id = ?`,
    [id]
  )
  return (rows[0] as EntityRow | undefined) ?? null
}
