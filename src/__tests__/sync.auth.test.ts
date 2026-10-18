/**
 * D-SY13 (Valdo, 2026-10-18) — a chave EXISTENTE e inativa tem recusa própria
 * (403 SYNC_KEY_INACTIVE), distinta da inexistente (401 SYNC_KEY_INVALID) e da
 * ausente (401 SYNC_KEY_MISSING); o Sincronizador para ao receber qualquer uma e
 * só volta quando o usuário ativa — a consulta GET /sync-key/status lê o banco
 * SEM o cache de 5 min e acerta o cache. Sem banco: o pool é falso.
 */

type KeyRow = { tb_institution_id: number; establishment_code: string; active: string; schema_name: string }
const mockKeys = new Map<string, KeyRow[]>()
const mockQuery = jest.fn(async (_sql: string, params: unknown[]) => [mockKeys.get(String(params[0])) ?? []])

jest.mock('@shared/db/connection', () => ({
  __esModule: true,
  default: { query: (sql: string, params: unknown[]) => mockQuery(sql, params), getConnection: jest.fn() },
}))

import request from 'supertest'
import app from '../app'

const row = (active: string): KeyRow =>
  ({ tb_institution_id: 7, establishment_code: '001', active, schema_name: 'setes_teste' })

beforeEach(() => {
  mockKeys.clear()
  mockQuery.mockClear()
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

describe('recusa da chave nos /sincronize', () => {
  it('sem header = 401 SYNC_KEY_MISSING', async () => {
    const res = await request(app).post('/brand/sincronize').send({})
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ ok: false, code: 'SYNC_KEY_MISSING' })
  })

  it('chave inexistente = 401 SYNC_KEY_INVALID', async () => {
    const res = await request(app).post('/brand/sincronize').set('X-Api-Key', 'nao-existe').send({})
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ ok: false, code: 'SYNC_KEY_INVALID' })
    expect(res.body.error).toContain('invalida')
  })

  it('chave existente e INATIVA = 403 SYNC_KEY_INACTIVE (não é mais o 401 da inexistente)', async () => {
    mockKeys.set('chave-inativa', [row('N')])
    const res = await request(app).post('/brand/sincronize').set('X-Api-Key', 'chave-inativa').send({})
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ ok: false, code: 'SYNC_KEY_INACTIVE' })
  })

  it('chave ativa passa da autenticação (o 400 é do payload, não da chave)', async () => {
    mockKeys.set('chave-ativa', [row('S')])
    const res = await request(app).post('/brand/sincronize').set('X-Api-Key', 'chave-ativa').send({})
    expect(res.status).toBe(400)
    expect(res.body.code).toBeUndefined()
  })
})

describe('GET /sync-key/status (botão "Ativar sincronia")', () => {
  it('ativa = 200 { ok, active }; sem expor institution/schema', async () => {
    mockKeys.set('k-ativa', [row('S')])
    const res = await request(app).get('/sync-key/status').set('X-Api-Key', 'k-ativa')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, active: true })
  })

  it('inativa = 403 SYNC_KEY_INACTIVE; inexistente = 401 SYNC_KEY_INVALID; sem header = 401', async () => {
    mockKeys.set('k-inativa', [row('N')])
    expect((await request(app).get('/sync-key/status').set('X-Api-Key', 'k-inativa')).body.code).toBe('SYNC_KEY_INACTIVE')
    const inex = await request(app).get('/sync-key/status').set('X-Api-Key', 'k-nada')
    expect(inex.status).toBe(401)
    expect(inex.body.code).toBe('SYNC_KEY_INVALID')
    expect((await request(app).get('/sync-key/status')).body.code).toBe('SYNC_KEY_MISSING')
  })

  it('lê o banco SEM o cache e acerta o cache: chave desativada para de passar na hora', async () => {
    mockKeys.set('k-cache', [row('S')])
    expect((await request(app).post('/brand/sincronize').set('X-Api-Key', 'k-cache').send({})).status).toBe(400)

    // desativada no banco: o middleware ainda a tem em cache (limite conhecido de 5 min)...
    mockKeys.set('k-cache', [row('N')])
    expect((await request(app).post('/brand/sincronize').set('X-Api-Key', 'k-cache').send({})).status).toBe(400)

    // ...a consulta do estado lê o banco, diz "inativa" e esquece o cache
    const st = await request(app).get('/sync-key/status').set('X-Api-Key', 'k-cache')
    expect(st.status).toBe(403)
    expect((await request(app).post('/brand/sincronize').set('X-Api-Key', 'k-cache').send({})).status).toBe(403)
  })

  it('reativada: o 1º pedido depois já passa (o negativo nunca é guardado)', async () => {
    mockKeys.set('k-volta', [row('N')])
    expect((await request(app).post('/brand/sincronize').set('X-Api-Key', 'k-volta').send({})).status).toBe(403)
    mockKeys.set('k-volta', [row('S')])
    expect((await request(app).get('/sync-key/status').set('X-Api-Key', 'k-volta')).status).toBe(200)
    expect((await request(app).post('/brand/sincronize').set('X-Api-Key', 'k-volta').send({})).status).toBe(400)
  })

  it('a consulta não é um /sincronize: não passa pelo middleware da chave', async () => {
    mockKeys.set('k-ativa2', [row('S')])
    await request(app).get('/sync-key/status').set('X-Api-Key', 'k-ativa2')
    // uma leitura só (a do refresh) — o middleware, se rodasse, faria outra
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })
})
