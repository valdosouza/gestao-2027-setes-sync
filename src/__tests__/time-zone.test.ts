/**
 * D-TZ4 (Valdo 2026-09-30, prompt_pesquisa_avancada.md §10.3) — o setes-sync grava os
 * instantes em UTC, como o setes-api (D-TZ1): sessão do banco '+00:00' fixada em toda
 * conexão nova e conferida no boot; a hora de parede do Delphi (caixa) vira instante
 * UTC pela zona do estabelecimento. Sem banco: o pool é falso.
 */

const mockConnQuery = jest.fn()
const mockPoolQuery = jest.fn()
const mockOn = jest.fn()
const mockConn = {
  query: (sql: string, params?: unknown[]) => mockConnQuery(sql, params),
  beginTransaction: jest.fn(async () => undefined),
  commit: jest.fn(async () => undefined),
  rollback: jest.fn(async () => undefined),
  release: jest.fn(),
}

jest.mock('mysql2/promise', () => ({
  __esModule: true,
  default: {
    createPool: jest.fn(() => ({
      on: (...a: unknown[]) => mockOn(...a),
      query: (sql: string, params?: unknown[]) => mockPoolQuery(sql, params),
      getConnection: jest.fn(async () => mockConn),
    })),
  },
}))

import mysql from 'mysql2/promise'
import request from 'supertest'
import { assertSessionTimeZoneUtc, fixSessionTimeZone } from '@shared/db/connection'
import { toUtcDb, institutionZoneFor, invalidateInstitutionZone, DEFAULT_TIME_ZONE } from '@shared/time-zone'
import app from '../app'

const KEY_ROW = { tb_institution_id: 7, establishment_code: '001', active: 'S', schema_name: 'setes_teste' }
// capturados no import (o beforeEach do jest limpa as chamadas)
const createPoolOpts = (mysql.createPool as jest.Mock).mock.calls[0]?.[0]
const onCalls = [...mockOn.mock.calls]

beforeEach(() => {
  mockConnQuery.mockReset()
  mockPoolQuery.mockReset()
  invalidateInstitutionZone()
  jest.spyOn(console, 'error').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => jest.restoreAllMocks())

describe('sessão do banco em UTC (D-TZ4)', () => {
  it('o driver serializa em UTC e toda conexão nova recebe SET time_zone = +00:00', () => {
    expect(createPoolOpts).toMatchObject({ timezone: 'Z' })
    expect(onCalls).toContainEqual(['connection', fixSessionTimeZone])

    const sqls: string[] = []
    fixSessionTimeZone({ query: (sql: string, cb: (e: unknown) => void) => { sqls.push(sql); cb(null) } })
    expect(sqls).toEqual([`SET time_zone = '+00:00'`])
  })

  it('falha do SET numa conexão nova não passa em silêncio', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    fixSessionTimeZone({ query: (_: string, cb: (e: unknown) => void) => cb(new Error('sem permissão')) })
    expect(err).toHaveBeenCalledWith(expect.stringContaining("time_zone '+00:00'"), expect.anything())
  })

  it('o boot aceita só sessão +00:00', async () => {
    mockPoolQuery.mockResolvedValueOnce([[{ tz: '+00:00' }]])
    await expect(assertSessionTimeZoneUtc()).resolves.toBe('+00:00')
    mockPoolQuery.mockResolvedValueOnce([[{ tz: 'SYSTEM' }]])
    await expect(assertSessionTimeZoneUtc()).rejects.toThrow(/SYSTEM.*'\+00:00'/)
  })
})

describe('toUtcDb — parede do legado → instante UTC', () => {
  it('sem offset: lida na zona (SP −3, Acre −5)', () => {
    expect(toUtcDb('2026-07-19 08:00:00', 'America/Sao_Paulo')).toBe('2026-07-19 11:00:00')
    expect(toUtcDb('2026-07-19 22:30', 'America/Sao_Paulo')).toBe('2026-07-20 01:30:00')
    expect(toUtcDb('2026-09-30 23:30:00', 'America/Rio_Branco')).toBe('2026-10-01 04:30:00')
    expect(toUtcDb('2026-07-19T08:00:00')).toBe('2026-07-19 11:00:00')   // default = SP
  })

  it('horário de verão antigo de SP (−2) é respeitado', () => {
    expect(toUtcDb('2018-12-01 10:00:00', 'America/Sao_Paulo')).toBe('2018-12-01 12:00:00')
  })

  it('com offset explícito vale o offset, não a zona', () => {
    expect(toUtcDb('2026-07-19T08:00:00Z', 'America/Sao_Paulo')).toBe('2026-07-19 08:00:00')
    expect(toUtcDb('2026-07-19T08:00:00-05:00', 'America/Sao_Paulo')).toBe('2026-07-19 13:00:00')
  })

  it('impossível ou vazio = null', () => {
    expect(toUtcDb('2026-02-30 10:00:00')).toBeNull()
    expect(toUtcDb('2026-07-19 25:00:00')).toBeNull()
    expect(toUtcDb('lixo')).toBeNull()
    expect(toUtcDb(null)).toBeNull()
    expect(toUtcDb('')).toBeNull()
  })
})

describe('institutionZoneFor', () => {
  const q = (zone: unknown) => ({ query: jest.fn(async () => [[{ zone }]]) })

  it('lê a zona configurada pela conexão recebida e guarda em cache', async () => {
    const conn = q('America/Manaus')
    expect(await institutionZoneFor('setes_teste', 7, conn)).toBe('America/Manaus')
    expect(await institutionZoneFor('setes_teste', 7, conn)).toBe('America/Manaus')
    expect(conn.query).toHaveBeenCalledTimes(1)
  })

  it('zona inválida, ausente ou schema estranho = America/Sao_Paulo', async () => {
    expect(await institutionZoneFor('setes_a', 1, q('Marte/Olympus'))).toBe(DEFAULT_TIME_ZONE)
    expect(await institutionZoneFor('setes_b', 1, q(null))).toBe(DEFAULT_TIME_ZONE)
    const conn = q('America/Manaus')
    expect(await institutionZoneFor('x`; DROP', 1, conn)).toBe(DEFAULT_TIME_ZONE)
    expect(conn.query).not.toHaveBeenCalled()
  })
})

describe('POST /cashier/sincronize grava hr_begin/hr_end em UTC', () => {
  const send = (body: object) =>
    request(app).post('/cashier/sincronize').set('X-Api-Key', 'chave-tz').send(body)

  beforeEach(() => {
    mockPoolQuery.mockImplementation(async () => [[KEY_ROW]])   // autenticação da chave
    mockConnQuery.mockImplementation(async (sql: string) =>
      /time_zone/.test(sql) ? [[{ zone: 'America/Rio_Branco' }]] : [[]])
  })

  const insertParams = () => {
    const call = mockConnQuery.mock.calls.find(([sql]) => /INSERT INTO tb_cashier/.test(sql))
    return call?.[1] as unknown[]
  }

  it('parede do Acre (−5) vira UTC; a data de negócio vai como veio; a zona é lida pela conn da transação', async () => {
    const res = await send({ id: 91, terminal: 1, dtRecord: '2026-07-19',
      hrBegin: '2026-07-19 08:00:00', hrEnd: '2026-07-19 21:30:00' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, id: 91 })
    const p = insertParams()
    expect(p[3]).toBe('2026-07-19')
    expect(p[5]).toBe('2026-07-19 13:00:00')
    expect(p[6]).toBe('2026-07-20 02:30:00')
    expect(mockConnQuery.mock.calls.some(([sql]) => /time_zone/.test(sql))).toBe(true)
    expect(mockPoolQuery.mock.calls.some(([sql]) => /time_zone/.test(sql))).toBe(false)
  })

  it('sem hora não consulta a zona e grava NULL', async () => {
    const res = await send({ id: 92, terminal: 1, dtRecord: '2026-07-19' })
    expect(res.status).toBe(200)
    const p = insertParams()
    expect(p[5]).toBeNull()
    expect(p[6]).toBeNull()
    expect(mockConnQuery.mock.calls.some(([sql]) => /time_zone/.test(sql))).toBe(false)
  })

  it('hora impossível = 400 e nada é gravado', async () => {
    const res = await send({ id: 93, terminal: 1, dtRecord: '2026-02-30', hrBegin: '2026-02-30 08:00:00' })
    expect(res.status).toBe(400)
    expect(res.body.ok).toBe(false)
    expect(insertParams()).toBeUndefined()
  })
})
