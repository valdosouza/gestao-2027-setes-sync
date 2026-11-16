/**
 * NOTA.E6.P1 (Q-C4) — o /order-service/sincronize não escreve mais a coluna
 * `tb_order_service.open_lock`: a trava da OS mora em `tb_service_order`
 * (migration 047 da setes-api) e a setes-api dropa a coluna da natureza em
 * deploy casado (setes-api:CANC.E5.P2). Sem banco.
 */

type Ev = { sql: string; params?: unknown[] }
const mockEvents: Ev[] = []

function mockConn() {
  return {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      mockEvents.push({ sql, params })
      if (/^\s*SELECT/i.test(sql)) return [[{ id: 1 }]]          // papéis existem
      return [{ affectedRows: 1, insertId: 0 }]
    }),
    beginTransaction: jest.fn(async () => undefined),
    commit:           jest.fn(async () => undefined),
    rollback:         jest.fn(async () => undefined),
    release:          jest.fn(() => undefined),
    destroy:          jest.fn(() => undefined),
  }
}

jest.mock('@shared/db/connection', () => ({
  __esModule: true,
  default: {
    getConnection: jest.fn(async () => mockConn()),
    query: jest.fn(async (sql: string) => {
      if (/tb_sync_api_key/.test(sql)) {
        return [[{ tb_institution_id: 7, establishment_code: '001', active: 'S', schema_name: 'setes_teste' }]]
      }
      return [[]]
    }),
  },
}))

jest.mock('@modules/sync/sync.entity', () => ({
  ...jest.requireActual('@modules/sync/sync.entity'),
  findEntityIdByDocument: jest.fn(async () => 42),
}))

jest.mock('@modules/sync/sync.user', () => ({
  ...jest.requireActual('@modules/sync/sync.user'),
  resolveFallbackUserId: jest.fn(async () => 9),
}))

import request from 'supertest'
import app from '../app'

beforeEach(() => { mockEvents.length = 0 })

describe('/order-service — sem a coluna open_lock (NOTA.E6.P1)', () => {
  it('o INSERT em tb_order_service é emitido e não cita open_lock', async () => {
    const res = await request(app)
      .post('/order-service/sincronize')
      .set('X-Api-Key', 'k-open-lock-1')
      .send({ id: 1001, terminal: 0, service: { number: 55, customerDocument: '52998224725' } })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, id: 1001 })

    const insert = mockEvents.find(e => /INSERT INTO tb_order_service\b/.test(e.sql))
    expect(insert).toBeDefined()                                   // o INSERT aconteceu
    expect(insert!.sql).not.toMatch(/open_lock/)
    expect(insert!.params).toEqual([1001, 7, 0, 55, 42, 'N'])     // id, inst, terminal, number, cliente, deleted
  })
})
