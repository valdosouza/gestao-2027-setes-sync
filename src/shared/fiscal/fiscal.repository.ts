import { randomUUID } from 'crypto'
import { Pool, PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { FiscalInput, PersonRow, CompanyRow, NoDocRow } from './fiscal.types'

type Executor = Pool | PoolConnection

/**
 * Persistência FISCAL (tb_person × tb_company × tb_no_doc, setes_central).
 * Peça independente (SRP): só conhece as tabelas do toggle de identificação;
 * o vínculo com a entity é o [entityId] recebido por parâmetro. Escrita é
 * TRANSACTION-AWARE (conn da transação aberta pelo chamador).
 *
 * Toggle TRIPLO (Fase 3, decisão 4): a especialização escolhida é upsertada
 * e as outras DUAS recebem soft delete — a exclusão mútua F/J/N vive AQUI,
 * em um lugar só.
 */

/** Toggle fiscal: upsert da especialização escolhida, soft delete das outras. */
export async function upsertFiscal(
  conn: PoolConnection, entityId: number, input: FiscalInput,
  updatedBy: number | null = null
): Promise<void> {
  if (input.personType === 'F') {
    await conn.query(
      `INSERT INTO setes_central.tb_person (id, cpf, rg, birthday, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, NOW(), NOW(), ?)
       ON DUPLICATE KEY UPDATE
         cpf = VALUES(cpf), rg = VALUES(rg), birthday = VALUES(birthday),
         deleted = 'N', updated_at = NOW(), updated_by = VALUES(updated_by)`,
      [entityId, input.person!.cpf, input.person!.rg ?? null,
       input.person!.birthday ?? null, updatedBy]
    )
  } else if (input.personType === 'J') {
    await conn.query(
      `INSERT INTO setes_central.tb_company (id, cnpj, ie, im, dt_foundation, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), ?)
       ON DUPLICATE KEY UPDATE
         cnpj = VALUES(cnpj), ie = VALUES(ie), im = VALUES(im),
         dt_foundation = VALUES(dt_foundation), deleted = 'N',
         updated_at = NOW(), updated_by = VALUES(updated_by)`,
      [entityId, input.company!.cnpj, input.company!.ie ?? null,
       input.company!.im ?? null, input.company!.dtFoundation ?? null, updatedBy]
    )
  } else {
    // 'N' — sem documento (decisão 5): external_id UUID v4 gerado aqui; se a
    // linha já existe (PK id), o ON DUPLICATE revive SEM trocar o external_id.
    await conn.query(
      `INSERT INTO setes_central.tb_no_doc (id, external_id, created_at, updated_at, updated_by)
       VALUES (?, ?, NOW(), NOW(), ?)
       ON DUPLICATE KEY UPDATE
         deleted = 'N', updated_at = NOW(), updated_by = VALUES(updated_by)`,
      [entityId, randomUUID(), updatedBy]
    )
  }

  const others: Record<string, string[]> = {
    F: ['tb_company', 'tb_no_doc'],
    J: ['tb_person', 'tb_no_doc'],
    N: ['tb_person', 'tb_company'],
  }
  for (const table of others[input.personType]) {
    await conn.query(
      `UPDATE setes_central.${table}
       SET deleted = 'S', updated_at = NOW(), updated_by = ?
       WHERE id = ? AND deleted = 'N'`,
      [updatedBy, entityId]
    )
  }
}

/**
 * Entity dona do CPF (null se livre). Dentro de transação passe a conn;
 * [lock] adiciona FOR UPDATE (reuso da Fase 3, decisão 9 — segura a linha
 * até o commit). Fora de transação (by-document/existência) usa o pool.
 */
export async function findEntityIdByCpf(
  cpf: string, db: Executor = pool, lock = false
): Promise<number | null> {
  const [rows] = await db.query<any[]>(
    `SELECT id FROM setes_central.tb_person WHERE cpf = ? AND deleted = 'N' LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [cpf]
  )
  return rows.length > 0 ? Number(rows[0].id) : null
}

/** Entity dona do CNPJ (null se livre) — mesmas regras do CPF. */
export async function findEntityIdByCnpj(
  cnpj: string, db: Executor = pool, lock = false
): Promise<number | null> {
  const [rows] = await db.query<any[]>(
    `SELECT id FROM setes_central.tb_company WHERE cnpj = ? AND deleted = 'N' LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [cnpj]
  )
  return rows.length > 0 ? Number(rows[0].id) : null
}

/** PF viva da entity (null se não é PF). Datas com DATE_FORMAT. */
export async function getPerson(entityId: number): Promise<PersonRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT cpf, rg, DATE_FORMAT(birthday, '%Y-%m-%d') AS birthday
     FROM setes_central.tb_person WHERE id = ? AND deleted = 'N'`,
    [entityId]
  )
  return (rows[0] as PersonRow | undefined) ?? null
}

/** PJ viva da entity (null se não é PJ). Datas com DATE_FORMAT. */
export async function getCompany(entityId: number): Promise<CompanyRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT cnpj, ie, im, DATE_FORMAT(dt_foundation, '%Y-%m-%d') AS dtFoundation
     FROM setes_central.tb_company WHERE id = ? AND deleted = 'N'`,
    [entityId]
  )
  return (rows[0] as CompanyRow | undefined) ?? null
}

/** Registro sem-doc vivo da entity (null se não é 'N'). */
export async function getNoDoc(entityId: number): Promise<NoDocRow | null> {
  const [rows] = await pool.query<any[]>(
    `SELECT external_id AS externalId
     FROM setes_central.tb_no_doc WHERE id = ? AND deleted = 'N'`,
    [entityId]
  )
  return (rows[0] as NoDocRow | undefined) ?? null
}
