/**
 * D-SY10 (= D-PR39, Valdo 2026-10-18) — catálogo central com a MESMA sistemática
 * do setes-api: chave por tabela (medida = abreviação), comparação UPPER(TRIM)
 * binária e a trava nomeada `GET_LOCK('setes_central.<tabela>', 10)` ANTES da
 * transação para CRIAR (PADROES_BANCO §9 regra 11). Gate socrático 2026-10-18:
 * leitura sem trava da linha VIVA primeiro (o caso comum não toma a trava global)
 * e o vínculo no schema do cliente FORA da seção global. Sem banco: conexão e pool
 * falsos registram a ORDEM das consultas — o protocolo é o que se prova aqui (o
 * catálogo central é compartilhado por todos os clientes; teste não grava nele).
 */

type Step = {
  kind: 'query' | 'pool' | 'begin' | 'commit' | 'rollback' | 'release' | 'destroy'
  sql?: string
  params?: unknown[]
}

interface FakeOptions {
  lockResult?:      number | null
  found?:           Array<{ id: number; deleted: string }>
  nextId?:          number
  failOn?:          RegExp          // a consulta da CONEXÃO que casar lança erro
  failReleaseLock?: boolean
}

const steps: Step[] = []
let options: FakeOptions = {}

function mockAnswer(sql: string): unknown {
  if (/GET_LOCK/.test(sql)) return [[{ ok: options.lockResult === undefined ? 1 : options.lockResult }]]
  if (/SELECT id, deleted FROM setes_central/.test(sql)) return [options.found ?? []]
  if (/SELECT id FROM setes_central/.test(sql)) return [(options.found ?? []).filter(r => r.deleted === 'N')]
  if (/MAX\(id\)/.test(sql)) return [[{ nextId: options.nextId ?? 42 }]]
  return [[]]
}

function mockConn() {
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      steps.push({ kind: 'query', sql, params })
      if (options.failOn && options.failOn.test(sql)) throw new Error('falha simulada')
      if (/RELEASE_LOCK/.test(sql) && options.failReleaseLock) throw new Error('conexão caiu')
      return mockAnswer(sql)
    }),
    beginTransaction: jest.fn(async () => { steps.push({ kind: 'begin' }) }),
    commit:           jest.fn(async () => { steps.push({ kind: 'commit' }) }),
    rollback:         jest.fn(async () => { steps.push({ kind: 'rollback' }) }),
    release:          jest.fn(() => { steps.push({ kind: 'release' }) }),
    destroy:          jest.fn(() => { steps.push({ kind: 'destroy' }) }),
  }
}

jest.mock('@shared/db/connection', () => ({
  __esModule: true,
  default: {
    getConnection: jest.fn(async () => mockConn()),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      steps.push({ kind: 'pool', sql, params })
      return mockAnswer(sql)
    }),
  },
}))

import {
  ensureAndLinkCatalogItem, ensureCatalogItem, resolveCatalogKey, CATALOG_DEDUPE_KEY,
} from '@modules/sync/sync.catalog'
import { HttpError } from '@shared/errors/http-error'

const sqlOf = (s: Step) => s.sql ?? ''
const indexOf = (re: RegExp, kind: Step['kind'] = 'query') =>
  steps.findIndex(s => s.kind === kind && re.test(sqlOf(s)))
const kindIndex = (k: Step['kind']) => steps.findIndex(s => s.kind === k)
const anySql = (re: RegExp) => steps.some(s => re.test(sqlOf(s)))

beforeEach(() => {
  steps.length = 0
  options = {}
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

describe('chave do dedupe por tabela (D-SY10 — a mesma dedupeBy do setes-api)', () => {
  it('medida pela abreviação; marca, embalagem e forma pela descrição', () => {
    expect(CATALOG_DEDUPE_KEY).toEqual({
      tb_brand: 'description', tb_package: 'description', tb_measure: 'abbreviation', tb_payment_types: 'description',
    })
  })

  it('medida com abreviação decide pela abreviação (a descrição é só atributo)', () => {
    expect(resolveCatalogKey('tb_measure', { abbreviation: ' un ', description: 'UNIDADE' }))
      .toEqual({ key: 'abbreviation', value: 'un' })
  })

  it('medida do legado SEM abreviação resolve pela descrição, com aviso no log', () => {
    const warn = console.warn as jest.Mock
    expect(resolveCatalogKey('tb_measure', { abbreviation: '', description: 'PECA SEM ABREV' }))
      .toEqual({ key: 'description', value: 'PECA SEM ABREV' })
    expect(resolveCatalogKey('tb_measure', { abbreviation: null, description: 'PECA SEM ABREV 2' }).key).toBe('description')
    expect(warn).toHaveBeenCalled()
  })

  it('embalagem com abreviação continua pela DESCRIÇÃO', () => {
    expect(resolveCatalogKey('tb_package', { description: 'CAIXA', abbreviation: 'CX' }))
      .toEqual({ key: 'description', value: 'CAIXA' })
  })

  it('chave vazia é erro de quem chama (o fallback do legado vem antes)', () => {
    expect(() => resolveCatalogKey('tb_measure', {})).toThrow()
    expect(() => resolveCatalogKey('tb_brand', { description: '  ' })).toThrow()
  })
})

describe('ensureAndLinkCatalogItem — caminho rápido, trava só para criar, vínculo fora da seção global', () => {
  it('item VIVO já existe: nenhuma trava, nenhuma conexão dedicada — só o vínculo', async () => {
    options = { found: [{ id: 3, deleted: 'N' }] }
    const r = await ensureAndLinkCatalogItem('tb_measure', 'setes_x', 3, { abbreviation: 'und', description: 'OUTRA' })
    expect(r).toEqual({ id: 3, reused: true, key: 'abbreviation' })
    expect(anySql(/GET_LOCK/)).toBe(false)
    expect(steps.some(s => s.kind === 'query')).toBe(false)      // nenhuma conexão do pool usada
    const fast = steps[indexOf(/SELECT id FROM setes_central/, 'pool')]
    expect(fast.sql).toMatch(/UPPER\(TRIM\(`abbreviation`\)\) COLLATE utf8mb4_bin = UPPER\(TRIM\(\?\)\) COLLATE utf8mb4_bin/)
    expect(fast.sql).toMatch(/deleted = 'N'/)
    expect(fast.sql).not.toMatch(/FOR UPDATE/)
    expect(fast.params).toEqual(['und'])
    expect(steps[indexOf(/INSERT INTO `setes_x`\.`tb_institution_has_measure`/, 'pool')].params).toEqual([3, 3])
    expect(anySql(/INSERT INTO setes_central|UPDATE setes_central/)).toBe(false)
  })

  it('cria pela abreviação: GET_LOCK → BEGIN → dedupe → INSERT → COMMIT → RELEASE_LOCK → vínculo', async () => {
    options = { nextId: 7 }
    const r = await ensureAndLinkCatalogItem('tb_measure', 'setes_x', 3,
      { abbreviation: 'KG', description: 'QUILOGRAMA', extras: { escale: 1 } }, { active: 'S' })
    expect(r).toEqual({ id: 7, reused: false, key: 'abbreviation' })

    const fast    = indexOf(/SELECT id FROM setes_central/, 'pool')
    const lock    = indexOf(/GET_LOCK/)
    const begin   = kindIndex('begin')
    const dedupe  = indexOf(/SELECT id, deleted FROM setes_central/)
    const insert  = indexOf(/INSERT INTO setes_central/)
    const commit  = kindIndex('commit')
    const release = indexOf(/RELEASE_LOCK/)
    const freed   = kindIndex('release')
    const link    = indexOf(/INSERT INTO `setes_x`\.`tb_institution_has_measure`/, 'pool')
    expect(fast).toBeGreaterThanOrEqual(0)
    expect(fast).toBeLessThan(lock)
    expect(lock).toBeLessThan(begin)
    expect(begin).toBeLessThan(dedupe)
    expect(dedupe).toBeLessThan(insert)
    expect(insert).toBeLessThan(commit)
    expect(commit).toBeLessThan(release)
    expect(release).toBeLessThan(freed)
    expect(freed).toBeLessThan(link)                              // o vínculo só depois de soltar a trava global

    // dentro da seção global, nada do schema do cliente
    expect(steps.slice(lock, release).some(s => /setes_x|tb_institution_has|USE /.test(sqlOf(s)))).toBe(false)

    // o MESMO nome e o MESMO prazo da trava do setes-api
    expect(steps[lock].params).toEqual(['setes_central.tb_measure', 10])
    expect(steps[release].params).toEqual(['setes_central.tb_measure'])

    const dedupeSql = sqlOf(steps[dedupe])
    expect(dedupeSql).toMatch(/UPPER\(TRIM\(`abbreviation`\)\) COLLATE utf8mb4_bin = UPPER\(TRIM\(\?\)\) COLLATE utf8mb4_bin/)
    expect(dedupeSql).not.toMatch(/FOR UPDATE/)          // retrato: a trava nomeada já serializa
    expect(dedupeSql).toMatch(/ORDER BY \(deleted = 'S'\), id/)  // a VIVA antes da morta
    expect(steps[dedupe].params).toEqual(['KG'])

    // descrição/escala = atributos da criação
    expect(steps[insert].sql).toMatch(/`id`, `description`, `abbreviation`, `escale`/)
    expect(steps[insert].params).toEqual([7, 'QUILOGRAMA', 'KG', 1])

    // espera curta na sessão, devolvida no fim
    expect(indexOf(/SET SESSION innodb_lock_wait_timeout = \?, lock_wait_timeout = \?/)).toBeLessThan(lock)
    expect(indexOf(/SET SESSION innodb_lock_wait_timeout = @setes_cat_prev_lw/)).toBeGreaterThan(release)

    // atributo do vínculo
    expect(steps[link].params).toEqual([3, 7, 'S'])
  })

  it('linha soft-deletada (sem viva): o caminho rápido não a vê e a trava a ressuscita', async () => {
    options = { found: [{ id: 9, deleted: 'S' }] }
    const r = await ensureAndLinkCatalogItem('tb_brand', 'setes_x', 3, { description: 'ACME' })
    expect(r).toEqual({ id: 9, reused: true, key: 'description' })
    expect(indexOf(/GET_LOCK/)).toBeGreaterThan(0)
    expect(indexOf(/UPDATE setes_central\.`tb_brand` SET deleted = 'N'/)).toBeGreaterThan(0)
  })

  it('medida criada só com a abreviação leva a abreviação como descrição (NOT NULL)', async () => {
    options = { nextId: 5 }
    await ensureAndLinkCatalogItem('tb_measure', 'setes_x', 3, { abbreviation: 'UND' })
    const ins = steps[indexOf(/INSERT INTO setes_central/)]
    expect(ins.params).toEqual([5, 'UND', 'UND'])
  })

  it('marca não tem abreviação na central', async () => {
    options = { nextId: 11 }
    await ensureAndLinkCatalogItem('tb_brand', 'setes_x', 3, { description: 'ACME', abbreviation: 'AC' })
    const ins = steps[indexOf(/INSERT INTO setes_central/)]
    expect(ins.sql).toMatch(/\(`id`, `description`, created_at/)
    expect(ins.params).toEqual([11, 'ACME'])
  })

  it('sem a trava em 10 s = 409 RESOURCE_BUSY, sem transação, sem RELEASE_LOCK e sem vínculo', async () => {
    options = { lockResult: 0 }
    const err = await ensureAndLinkCatalogItem('tb_package', 'setes_x', 3, { description: 'CAIXA' }).catch(e => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.statusCode).toBe(409)
    expect(err.code).toBe('RESOURCE_BUSY')
    expect(kindIndex('begin')).toBe(-1)
    expect(indexOf(/RELEASE_LOCK/)).toBe(-1)
    expect(anySql(/tb_institution_has_package/)).toBe(false)
    expect(steps[steps.length - 1].kind).toBe('release')
  })

  it('GET_LOCK com erro (NULL) também é 409', async () => {
    options = { lockResult: null }
    const err = await ensureAndLinkCatalogItem('tb_package', 'setes_x', 3, { description: 'CAIXA' }).catch(e => e)
    expect(err.statusCode).toBe(409)
  })

  it('falha no meio: ROLLBACK, solta a trava, propaga o erro original e não vincula', async () => {
    options = { failOn: /INSERT INTO setes_central/ }
    const err = await ensureAndLinkCatalogItem('tb_measure', 'setes_x', 3, { abbreviation: 'KG' }).catch(e => e)
    expect(err.message).toBe('falha simulada')
    expect(kindIndex('rollback')).toBeGreaterThan(0)
    expect(kindIndex('commit')).toBe(-1)
    expect(indexOf(/RELEASE_LOCK/)).toBeGreaterThan(kindIndex('rollback'))
    expect(anySql(/tb_institution_has_measure/)).toBe(false)
    expect(steps[steps.length - 1].kind).toBe('release')
  })

  it('RELEASE_LOCK que falha DESCARTA a conexão (nunca volta ao pool segurando a trava)', async () => {
    options = { failReleaseLock: true }
    await ensureAndLinkCatalogItem('tb_measure', 'setes_x', 3, { abbreviation: 'KG' })
    expect(kindIndex('destroy')).toBeGreaterThan(0)
    expect(kindIndex('release')).toBe(-1)
  })
})

describe('semântica FIXADA até a decisão do Valdo (gate adversarial 2026-10-18)', () => {
  it('Q-SY22: duas medidas do MESMO cliente com a mesma abreviação dividem a linha central e o vínculo — o ÚLTIMO /measure decide o active', async () => {
    options = { found: [{ id: 1, deleted: 'N' }] }
    // UNIDADE/UND viva e depois UNIDADE VELHA/und com DELETED='S' no legado
    await ensureAndLinkCatalogItem('tb_measure', 'setes_x', 3, { abbreviation: 'UND', description: 'UNIDADE' }, { active: 'S' })
    await ensureAndLinkCatalogItem('tb_measure', 'setes_x', 3, { abbreviation: 'und', description: 'UNIDADE VELHA' }, { active: 'N' })
    const links = steps.filter(s => s.kind === 'pool' && /tb_institution_has_measure/.test(sqlOf(s)))
    expect(links.map(l => l.params)).toEqual([[3, 1, 'S'], [3, 1, 'N']])
  })
})

describe('ensureCatalogItem — forma de pagamento dentro da transação de quem chama (protocolo antigo, Q-SY17)', () => {
  it('mantém a leitura travante de sempre e não pega trava nomeada', async () => {
    const conn = mockConn() as any
    options = { nextId: 4 }
    const r = await ensureCatalogItem(conn, 'tb_payment_types', { description: 'PIX', extras: { id_nfce: '17' } })
    expect(r).toEqual({ id: 4, reused: false, key: 'description' })
    expect(steps[indexOf(/SELECT id, deleted FROM setes_central/)].sql).toMatch(/FOR UPDATE/)
    expect(indexOf(/GET_LOCK/)).toBe(-1)
    expect(steps[indexOf(/INSERT INTO setes_central/)].params).toEqual([4, 'PIX', '17'])
  })
})
