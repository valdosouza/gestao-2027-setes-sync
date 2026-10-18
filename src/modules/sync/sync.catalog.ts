import { PoolConnection } from 'mysql2/promise'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

/**
 * MOTOR DE CATÁLOGO CENTRAL (decisões D5/D17/D24) — padrão "catálogo
 * iniciado pelo cliente" (PADROES_BANCO §5, molde tb_payment_types):
 * a linha vive UMA vez em setes_central; o uso da institution fica no
 * vínculo setes_<schema>.tb_institution_has_<x>.
 *
 * CHAVE DO DEDUPE POR TABELA (D-SY10 = D-PR39, Valdo 2026-10-18): a MESMA
 * sistemática do setes-api (`@shared/central-catalog`, `dedupeBy`) — medida
 * pela ABREVIAÇÃO (é a unidade comercial/tributável da NF-e e unifica o
 * cadastro de todos os clientes); marca, embalagem e forma de pagamento pela
 * DESCRIÇÃO. O que não é a chave é ATRIBUTO gravado só na CRIAÇÃO.
 *
 * Comparação (D17): UPPER(TRIM(chave)) em utf8mb4_bin — case-insensitive SEM
 * colapsar acentos ('AÇO' ≠ 'ACO'; a collation unicode_ci da coluna fundiria
 * os dois, por isso a comparação é forçada para binário DEPOIS do UPPER).
 *
 * Reuso NÃO sobrescreve os atributos da linha central (um cliente não
 * clobbera o catálogo dos outros — mesmo espírito do upsertLink das
 * Formas v2). Linha soft-deletada é ressuscitada (D17) SÓ quando não há
 * linha VIVA com a mesma chave — a viva vem primeiro (o setes-api só enxerga
 * as vivas: preferir a viva impede que os dois escritores acabem com duas
 * linhas vivas da mesma chave).
 *
 * SERIALIZAÇÃO (D-SY10 + PADROES_BANCO §9 regra 11): marca, embalagem e
 * medida têm DOIS escritores (setes-sync e setes-api) — os dois pegam a
 * MESMA trava nomeada `GET_LOCK('setes_central.<tabela>', 10)` ANTES da
 * transação para CRIAR (`ensureAndLinkCatalogItem`: leitura sem trava da linha
 * viva primeiro; trava só para criar/reviver; vínculo do cliente fora da seção
 * global). Esses três NÃO podem ser criados por `ensureCatalogItem` dentro de uma
 * transação aberta (o tipo impede).
 */

export type CatalogTable = 'tb_brand' | 'tb_package' | 'tb_measure' | 'tb_payment_types'

/** Catálogos com dois escritores (setes-sync × setes-api) — só pela trava nomeada. */
export type LockedCatalogTable = 'tb_brand' | 'tb_package' | 'tb_measure'

/** Catálogo criado DENTRO da transação de quem chama (protocolo antigo — forma de pagamento; Q-SY17). */
export type InTransactionCatalogTable = Exclude<CatalogTable, LockedCatalogTable>

/** Chave do dedupe por tabela — a mesma `dedupeBy` do setes-api (`@shared/central-catalog`). */
export const CATALOG_DEDUPE_KEY: Readonly<Record<CatalogTable, 'description' | 'abbreviation'>> = {
  tb_brand:         'description',
  tb_package:       'description',
  tb_measure:       'abbreviation',
  tb_payment_types: 'description',
}

/** Tabelas centrais com a coluna `abbreviation`. */
const HAS_ABBREVIATION: ReadonlySet<CatalogTable> = new Set<CatalogTable>(['tb_package', 'tb_measure'])

/** Vínculo institution × item no schema do cliente. */
const CATALOG_LINK: Readonly<Record<LockedCatalogTable, { hasTable: string; fkColumn: string }>> = {
  tb_brand:   { hasTable: 'tb_institution_has_brand',   fkColumn: 'tb_brand_id' },
  tb_package: { hasTable: 'tb_institution_has_package', fkColumn: 'tb_package_id' },
  tb_measure: { hasTable: 'tb_institution_has_measure', fkColumn: 'tb_measure_id' },
}

export interface CatalogItemInput {
  /** Chave (marca/embalagem/forma) ou atributo da criação (medida). */
  description?:  string | null
  /** Chave da medida; atributo da criação da embalagem. */
  abbreviation?: string | null
  /** Outros atributos gravados só na CRIAÇÃO (ex.: escale da medida, flags da forma). */
  extras?:       Record<string, string | number | null>
}

export interface EnsureCatalogResult {
  id:     number
  reused: boolean
  /** Coluna que de fato decidiu o dedupe — `description` na medida sem abreviação (legado). */
  key:    'description' | 'abbreviation'
}

/** Espera máxima (s) da trava nomeada E das travas InnoDB/metadados enquanto ela é segurada — igual ao setes-api. */
export const CATALOG_LOCK_WAIT_SECONDS = 10

// Aviso da medida sem abreviação: um por descrição por processo (a carga inicial
// de um executável antigo mandaria um aviso por produto).
const warnedMeasureDescriptions = new Set<string>()
const WARN_MEMO_LIMIT = 1000

function warnMeasureByDescription(description: string): void {
  const memo = description.toUpperCase()
  if (warnedMeasureDescriptions.has(memo)) return
  if (warnedMeasureDescriptions.size < WARN_MEMO_LIMIT) warnedMeasureDescriptions.add(memo)
  logger.warn('Medida sem abreviação — resolvida pela DESCRIÇÃO (D-SY10: a chave da medida é a abreviação; ' +
    'executável antigo ou MED_ABREVIATURA vazia no legado)', { description })
}

/** Qual coluna decide o dedupe e com que valor (a medida sem abreviação cai na descrição). */
export function resolveCatalogKey(
  table: CatalogTable, input: CatalogItemInput
): { key: 'description' | 'abbreviation'; value: string } {
  const description  = (input.description  ?? '').trim()
  const abbreviation = (input.abbreviation ?? '').trim()
  if (CATALOG_DEDUPE_KEY[table] === 'abbreviation') {
    if (abbreviation !== '') return { key: 'abbreviation', value: abbreviation }
    if (description !== '') {
      warnMeasureByDescription(description)
      return { key: 'description', value: description }
    }
    throw new Error(`${table}: abreviação e descrição vazias — quem chama aplica o fallback antes`)
  }
  if (description === '') throw new Error(`${table}: descrição vazia — quem chama aplica o fallback antes`)
  return { key: 'description', value: description }
}

/**
 * Dedupe + criação na conexão de quem chama (transação já aberta).
 * `lockingRead`: a forma de pagamento (sem trava nomeada) lê com FOR UPDATE como sempre;
 * os catálogos da trava nomeada leem o RETRATO — a transação começou DEPOIS da trava,
 * então o retrato já vê o item do criador anterior (o FOR UPDATE numa coluna sem índice
 * travaria a tabela central inteira, de todos os clientes — M4 do setes-api).
 */
async function findOrCreateCatalogItem(
  conn: PoolConnection, table: CatalogTable, input: CatalogItemInput, lockingRead: boolean
): Promise<EnsureCatalogResult> {
  const { key, value } = resolveCatalogKey(table, input)

  const [found] = await conn.query<any[]>(
    `SELECT id, deleted FROM setes_central.\`${table}\`
     WHERE UPPER(TRIM(\`${key}\`)) COLLATE utf8mb4_bin = UPPER(TRIM(?)) COLLATE utf8mb4_bin
     ORDER BY (deleted = 'S'), id
     LIMIT 1${lockingRead ? ' FOR UPDATE' : ''}`,
    [value]
  )

  if (found.length > 0) {
    const id = Number(found[0].id)
    if (found[0].deleted === 'S') {
      await conn.query(
        `UPDATE setes_central.\`${table}\` SET deleted = 'N', updated_at = NOW() WHERE id = ?`,
        [id]
      )
    }
    return { id, reused: true, key }
  }

  const [rows] = await conn.query<any[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.\`${table}\` FOR UPDATE`
  )
  const id = Number(rows[0].nextId)

  // descrição é NOT NULL: a medida criada só com a abreviação leva a abreviação como descrição
  const description  = (input.description ?? '').trim() || value
  const abbreviation = (input.abbreviation ?? '').trim() || null
  const extras = { ...(input.extras ?? {}) }
  delete extras.description
  delete extras.abbreviation
  const cols:   string[] = ['id', 'description']
  const values: Array<string | number | null> = [id, description]
  if (HAS_ABBREVIATION.has(table)) { cols.push('abbreviation'); values.push(abbreviation) }
  for (const [c, v] of Object.entries(extras)) { cols.push(c); values.push(v) }

  await conn.query(
    `INSERT INTO setes_central.\`${table}\`
       (${cols.map(c => `\`${c}\``).join(', ')}, created_at, updated_at)
     VALUES (${cols.map(() => '?').join(', ')}, NOW(), NOW())`,
    values
  )
  return { id, reused: false, key }
}

/**
 * Forma de pagamento: dedupe + criação DENTRO da transação de quem chama, com
 * leitura travante (protocolo de sempre do setes-sync — fora do escopo da D-SY10).
 * ⚠️ Ela TAMBÉM tem dois escritores: o setes-api (`@shared/payment-types`) cria a
 * mesma linha central comparando `description = ?` na colação _ci (funde acentos)
 * e sem a trava nomeada — alinhar as duas sistemáticas é a Q-SY17 (aguarda o Valdo).
 * Marca, embalagem e medida NÃO passam aqui — `ensureAndLinkCatalogItem`.
 */
export async function ensureCatalogItem(
  conn: PoolConnection,
  table: InTransactionCatalogTable,
  input: CatalogItemInput
): Promise<EnsureCatalogResult> {
  return findOrCreateCatalogItem(conn, table, input, true)
}

/** Quem executa uma consulta: conexão do pool ou o próprio pool (autocommit). */
type Queryable = Pick<PoolConnection, 'query'>

/**
 * Caminho rápido, SEM trava: a linha VIVA com a mesma chave e a mesma comparação.
 * Decide só no POSITIVO — linha viva gravada não "desacontece" (nenhum código apaga
 * linha central de marca/embalagem/medida; a peça do setes-api também só lê vivas).
 * Não achou (ou só morta) = caminho da trava, que relê sob a serialização.
 */
async function findLiveCatalogItem(
  table: LockedCatalogTable, input: CatalogItemInput
): Promise<EnsureCatalogResult | null> {
  const { key, value } = resolveCatalogKey(table, input)
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM setes_central.\`${table}\`
     WHERE UPPER(TRIM(\`${key}\`)) COLLATE utf8mb4_bin = UPPER(TRIM(?)) COLLATE utf8mb4_bin
       AND deleted = 'N'
     ORDER BY id LIMIT 1`,
    [value]
  )
  return rows.length > 0 ? { id: Number(rows[0].id), reused: true, key } : null
}

/**
 * Criação (ou revive) do item central numa transação PRÓPRIA serializada pela trava
 * nomeada `setes_central.<tabela>` — o MESMO protocolo e o MESMO nome do setes-api
 * (`createAndLinkCatalogItem`, PADROES_BANCO §9 regra 11): GET_LOCK ANTES da
 * transação, RELEASE_LOCK no finally, sem a trava em 10 s = 409 RESOURCE_BUSY.
 * Dentro da seção global SÓ tabela central — nada do schema de um cliente.
 */
async function createCatalogItemLocked(
  table: LockedCatalogTable, input: CatalogItemInput
): Promise<EnsureCatalogResult> {
  const conn = await pool.getConnection()
  const lockName = `setes_central.${table}`
  let locked = false
  let shortened = false
  let inTransaction = false
  let reusable = true
  try {
    // quem segura uma trava GLOBAL (todos os clientes) nunca espera trava sem prazo
    // (molde do setes-api): espera curta na SESSÃO, devolvida no finally
    await conn.query('SET @setes_cat_prev_lw = @@session.innodb_lock_wait_timeout, @setes_cat_prev_mdl = @@session.lock_wait_timeout')
    shortened = true
    await conn.query('SET SESSION innodb_lock_wait_timeout = ?, lock_wait_timeout = ?',
      [CATALOG_LOCK_WAIT_SECONDS, CATALOG_LOCK_WAIT_SECONDS])
    const [got] = await conn.query<any[]>('SELECT GET_LOCK(?, ?) AS ok', [lockName, CATALOG_LOCK_WAIT_SECONDS])
    if (Number(got[0]?.ok) !== 1) {
      throw new HttpError(409, 'Catálogo central em uso por outra operação — tente novamente',
        undefined, 'RESOURCE_BUSY')
    }
    locked = true

    await conn.beginTransaction()
    inTransaction = true
    const item = await findOrCreateCatalogItem(conn, table, input, false)
    await conn.commit()
    inTransaction = false
    return item
  } catch (err) {
    if (inTransaction) {
      try { await conn.rollback() } catch { reusable = false }   // a falha do rollback não mascara o erro original
    }
    throw err
  } finally {
    // conexão que voltaria ao pool SEGURANDO a trava nomeada (o GET_LOCK é da sessão e
    // recursivo) ou com a espera encurtada = DESCARTADA
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => { reusable = false })
    if (shortened && reusable) {
      await conn.query('SET SESSION innodb_lock_wait_timeout = @setes_cat_prev_lw, lock_wait_timeout = @setes_cat_prev_mdl')
        .catch(() => { reusable = false })
    }
    if (reusable) conn.release()
    else conn.destroy()
  }
}

/**
 * Marca, embalagem e medida: garante o item na central + o vínculo da institution.
 *
 * 1. Caminho rápido sem trava (`findLiveCatalogItem`) — o caso comum (o item já existe)
 *    não toma a trava global.
 * 2. Senão, criação/revive sob a trava nomeada (`createCatalogItemLocked`) — o MESMO
 *    protocolo do setes-api.
 * 3. Vínculo no schema do cliente FORA da trava global — diferença CONSCIENTE da peça
 *    do setes-api, que vincula dentro: o INSERT do vínculo pede S na linha da
 *    institution (FK) e pode esperar quem trava o cliente (ex.: `lockInstitutionCounters`
 *    do faturamento) — esperar o lock de UM cliente segurando a trava de TODOS pararia a
 *    frota (gate socrático, 2026-10-18). Vínculo que falhar deixa a linha central (dado
 *    real do legado); o reenvio vincula.
 *
 * Cada passo usa e devolve a sua conexão: quem chama NÃO pode estar segurando outra
 * (20 requisições segurando uma e esperando a segunda esgotariam o pool para sempre) —
 * o /merchandise resolve os catálogos ANTES de pegar a conexão da transação principal.
 *
 * `linkAttrs`: atributos do vínculo (ex.: `active` pelo `deleted` do /brand). Sem attrs
 * só garante o vínculo vivo (o /merchandise não mexe no `active` do vínculo).
 */
export async function ensureAndLinkCatalogItem(
  table: LockedCatalogTable,
  schemaName: string,
  institutionId: number,
  input: CatalogItemInput,
  linkAttrs: Record<string, string | number> = {}
): Promise<EnsureCatalogResult> {
  const item = (await findLiveCatalogItem(table, input)) ?? (await createCatalogItemLocked(table, input))
  const { hasTable, fkColumn } = CATALOG_LINK[table]
  await upsertCatalogLink(pool, hasTable, fkColumn, institutionId, item.id, linkAttrs, schemaName)
  return item
}

/**
 * Vínculo institution × catálogo no schema do CLIENTE — `schemaName` qualifica a
 * tabela; sem ele a conexão já deve estar com USE no schema. [attrs] atualiza
 * atributos do vínculo (ex.: active 'S'/'N' — soft delete do Firebird desabilita
 * o vínculo, nunca a linha central). Sem attrs: só garante o vínculo vivo.
 */
export async function upsertCatalogLink(
  conn: Queryable,
  hasTable: string,
  fkColumn: string,
  institutionId: number,
  catalogId: number,
  attrs: Record<string, string | number> = {},
  schemaName?: string
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
    `INSERT INTO ${schemaName ? `\`${schemaName}\`.` : ''}\`${hasTable}\`
       (${insertCols.map(c => `\`${c}\``).join(', ')}, created_at, updated_at, deleted)
     VALUES (${insertCols.map(() => '?').join(', ')}, NOW(), NOW(), 'N')
     ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
    insertVals
  )
}
