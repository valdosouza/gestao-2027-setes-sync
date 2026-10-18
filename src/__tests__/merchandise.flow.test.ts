/**
 * D-SY10 — fluxo do /merchandise/sincronize: categoria conferida ANTES do catálogo
 * (o 409 CATEGORY_NOT_SYNCED não cria item central), cada catálogo na sua conexão e
 * transação sob a trava nomeada, e só DEPOIS a conexão da transação do produto —
 * a requisição nunca segura duas conexões do pool ao mesmo tempo. Sem banco.
 */

type Ev = { conn: number; kind: string; sql?: string; params?: unknown[] }
const mockEvents: Ev[] = []
const mockState = { categorySynced: true, catalogExists: false, connSeq: 0, open: 0, maxOpen: 0 }

function mockConn() {
  const id = ++mockState.connSeq
  mockState.open++
  mockState.maxOpen = Math.max(mockState.maxOpen, mockState.open)
  const push = (kind: string, sql?: string, params?: unknown[]) => mockEvents.push({ conn: id, kind, sql, params })
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      push('query', sql, params)
      if (/GET_LOCK/.test(sql)) return [[{ ok: 1 }]]
      if (/SELECT id, deleted FROM setes_central/.test(sql)) return [[]]
      if (/MAX\(id\)/.test(sql)) return [[{ nextId: 10 + id }]]
      if (/FROM `[^`]+`\.tb_category/.test(sql)) return [mockState.categorySynced ? [{ id: 12 }] : []]
      return [[]]
    }),
    beginTransaction: jest.fn(async () => push('begin')),
    commit:           jest.fn(async () => push('commit')),
    rollback:         jest.fn(async () => push('rollback')),
    release:          jest.fn(() => { mockState.open--; push('release') }),
    destroy:          jest.fn(() => { mockState.open--; push('destroy') }),
  }
}

jest.mock('@shared/db/connection', () => ({
  __esModule: true,
  default: {
    getConnection: jest.fn(async () => mockConn()),
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      mockEvents.push({ conn: 0, kind: 'pool', sql, params })
      if (/tb_sync_api_key/.test(sql)) {
        return [[{ tb_institution_id: 7, establishment_code: '001', active: 'S', schema_name: 'setes_teste' }]]
      }
      if (/tb_category/.test(sql)) return [mockState.categorySynced ? [{ id: 12 }] : []]
      if (/SELECT id FROM setes_central/.test(sql)) return [mockState.catalogExists ? [{ id: 3 }] : []]
      return [[]]
    }),
  },
}))

import request from 'supertest'
import app from '../app'

const body = (stock: Record<string, unknown>) => ({
  id: 501,
  product: { description: 'PARAFUSO 6MM', categoryId: 12, kind: 'P' },
  merchandise: { nameBrand: 'ACME' },
  stock: { namePackage: 'CAIXA', ...stock },
})

beforeEach(() => {
  mockEvents.length = 0
  mockState.categorySynced = true
  mockState.catalogExists = false
  mockState.connSeq = 0
  mockState.open = 0
  mockState.maxOpen = 0
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

const post = (key: string, payload: object) =>
  request(app).post('/merchandise/sincronize').set('X-Api-Key', key).send(payload)

describe('/merchandise — ordem do catálogo central (D-SY10)', () => {
  it('categoria não sincronizada: 409 sem tocar no catálogo nem abrir transação', async () => {
    mockState.categorySynced = false
    const res = await post('k-flow-1', body({ measureAbbreviation: 'KG', nameMeasure: 'QUILOGRAMA' }))
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('CATEGORY_NOT_SYNCED')
    expect(mockState.connSeq).toBe(0)
    expect(mockEvents.some(e => /GET_LOCK|INSERT INTO setes_central/.test(e.sql ?? ''))).toBe(false)
  })

  it('marca → embalagem → medida, cada uma com a sua trava; depois a transação do produto; nunca 2 conexões', async () => {
    const res = await post('k-flow-2', body({ measureAbbreviation: 'kg', nameMeasure: 'QUILOGRAMA' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 501 })

    const locks = mockEvents.filter(e => /GET_LOCK/.test(e.sql ?? ''))
    expect(locks.map(e => e.params?.[0])).toEqual(
      ['setes_central.tb_brand', 'setes_central.tb_package', 'setes_central.tb_measure'])
    expect(new Set(locks.map(e => e.conn)).size).toBe(3)      // uma conexão por catálogo

    const measureDedupe = mockEvents.find(e => e.conn === locks[2].conn && /SELECT id, deleted FROM setes_central/.test(e.sql ?? ''))
    expect(measureDedupe?.sql).toMatch(/`abbreviation`/)
    expect(measureDedupe?.params).toEqual(['kg'])

    // a conexão da transação do produto é a 4ª e só nasce depois de os 3 catálogos soltarem a deles
    const mainConn = 4
    const firstMain = mockEvents.findIndex(e => e.conn === mainConn)
    const lastCatalogRelease = mockEvents.map((e, i) => ({ e, i }))
      .filter(x => x.e.conn > 0 && x.e.conn < mainConn && x.e.kind === 'release').pop()!.i
    expect(firstMain).toBeGreaterThan(lastCatalogRelease)
    expect(mockEvents.filter(e => e.conn === mainConn && /INSERT INTO setes_central|GET_LOCK/.test(e.sql ?? ''))).toEqual([])
    expect(mockState.maxOpen).toBe(1)
    expect(mockState.open).toBe(0)
  })

  it('catálogos já existentes (o caso comum): nenhuma trava global — só a conexão do produto', async () => {
    mockState.catalogExists = true
    const res = await post('k-flow-5', body({ measureAbbreviation: 'KG', nameMeasure: 'QUILOGRAMA' }))
    expect(res.status).toBe(200)
    expect(mockEvents.some(e => /GET_LOCK/.test(e.sql ?? ''))).toBe(false)
    expect(mockState.connSeq).toBe(1)
    const links = mockEvents.filter(e => e.kind === 'pool' && /INSERT INTO `setes_teste`\.`tb_institution_has_/.test(e.sql ?? ''))
    expect(links).toHaveLength(3)
  })

  it('executável antigo (só nameMeasure): a medida resolve pela descrição', async () => {
    const res = await post('k-flow-3', body({ nameMeasure: 'UNIDADE' }))
    expect(res.status).toBe(200)
    const lockMeasure = mockEvents.find(e => /GET_LOCK/.test(e.sql ?? '') && e.params?.[0] === 'setes_central.tb_measure')!
    const dedupe = mockEvents.find(e => e.conn === lockMeasure.conn && /SELECT id, deleted FROM setes_central/.test(e.sql ?? ''))
    expect(dedupe?.sql).toMatch(/`description`/)
    expect(dedupe?.params).toEqual(['UNIDADE'])
  })

  it("sem medida nenhuma: dedupe pela ABREVIAÇÃO 'UND'", async () => {
    const res = await post('k-flow-4', body({}))
    expect(res.status).toBe(200)
    const lockMeasure = mockEvents.find(e => /GET_LOCK/.test(e.sql ?? '') && e.params?.[0] === 'setes_central.tb_measure')!
    const dedupe = mockEvents.find(e => e.conn === lockMeasure.conn && /SELECT id, deleted FROM setes_central/.test(e.sql ?? ''))
    expect(dedupe?.sql).toMatch(/`abbreviation`/)
    expect(dedupe?.params).toEqual(['UND'])
  })
})
