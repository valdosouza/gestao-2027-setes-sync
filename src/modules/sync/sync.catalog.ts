import { PoolConnection } from 'mysql2/promise'

/**
 * MOTOR DE CATÁLOGO CENTRAL (decisões D5/D17/D24) — padrão "catálogo
 * iniciado pelo cliente" (PADROES_BANCO §5, molde tb_payment_types):
 * a linha vive UMA vez em setes_central, deduplicada por DESCRIÇÃO; o uso
 * da institution fica no vínculo setes_<schema>.tb_institution_has_<x>.
 *
 * Dedupe (D17): UPPER(TRIM(descricao)) comparado em utf8mb4_bin —
 * case-insensitive SEM colapsar acentos ('AÇO' ≠ 'ACO'; a collation
 * unicode_ci da coluna fundiria os dois, por isso a comparação é forçada
 * para binário DEPOIS do UPPER).
 *
 * Reuso NÃO sobrescreve os atributos da linha central (um cliente não
 * clobbera o catálogo dos outros — mesmo espírito do upsertLink das
 * Formas v2); linha soft-deletada é ressuscitada.
 */

export type CatalogTable = 'tb_brand' | 'tb_package' | 'tb_measure' | 'tb_payment_types'

export interface EnsureCatalogResult {
  id:     number
  reused: boolean
}

export async function ensureCatalogItem(
  conn: PoolConnection,
  table: CatalogTable,
  description: string,
  extras: Record<string, string | number | null> = {}
): Promise<EnsureCatalogResult> {
  const desc = description.trim()

  const [found] = await conn.query<any[]>(
    `SELECT id, deleted FROM setes_central.\`${table}\`
     WHERE UPPER(TRIM(description)) COLLATE utf8mb4_bin = UPPER(?) COLLATE utf8mb4_bin
     LIMIT 1 FOR UPDATE`,
    [desc]
  )

  if (found.length > 0) {
    const id = Number(found[0].id)
    if (found[0].deleted === 'S') {
      await conn.query(
        `UPDATE setes_central.\`${table}\` SET deleted = 'N', updated_at = NOW() WHERE id = ?`,
        [id]
      )
    }
    return { id, reused: true }
  }

  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.\`${table}\` FOR UPDATE`
  )
  const id = Number(rows[0].nextId)

  const cols   = ['id', 'description', ...Object.keys(extras)]
  const values = [id, desc, ...Object.values(extras)]
  await conn.query(
    `INSERT INTO setes_central.\`${table}\`
       (${cols.map(c => `\`${c}\``).join(', ')}, created_at, updated_at)
     VALUES (${cols.map(() => '?').join(', ')}, NOW(), NOW())`,
    values
  )
  return { id, reused: false }
}

/**
 * Vínculo institution × catálogo no schema do CLIENTE (a conexão já deve
 * estar com USE no schema). [attrs] atualiza atributos do vínculo (ex.:
 * active 'S'/'N' — soft delete do Firebird desabilita o vínculo, nunca a
 * linha central). Sem attrs: só garante o vínculo vivo.
 */
export async function upsertCatalogLink(
  conn: PoolConnection,
  hasTable: string,
  fkColumn: string,
  institutionId: number,
  catalogId: number,
  attrs: Record<string, string | number> = {}
): Promise<void> {
  const attrCols = Object.keys(attrs)
  const insertCols = ['tb_institution_id', fkColumn, ...attrCols]
  const insertVals = [institutionId, catalogId, ...Object.values(attrs)]
  const updates = [
    `deleted = 'N'`,
    `updated_at = NOW()`,
    ...attrCols.map(c => `\`${c}\` = VALUES(\`${c}\`)`),
  ]
  await conn.query(
    `INSERT INTO \`${hasTable}\`
       (${insertCols.map(c => `\`${c}\``).join(', ')}, created_at, updated_at, deleted)
     VALUES (${insertCols.map(() => '?').join(', ')}, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
    insertVals
  )
}
