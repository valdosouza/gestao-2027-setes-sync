import pool from '@shared/db/connection'
import { PoolConnection } from 'mysql2/promise'
import { saveSyncEntity, syncEntityBody, stripDocumentMasks, SyncEntityInput } from '@modules/sync/sync.entity'

/**
 * Prova os critérios de sucesso 2 e 3 do prompt da revisão
 * (prompt_revisao_sincronizador_setes_sync.md):
 *  2. mesmo CNPJ vindo de novo NÃO duplica entity (reindexação D3)
 *  3. sem documento → UUID devolvido; REENVIO com o UUID não duplica (D4)
 */

// Gera CPF/CNPJ VÁLIDOS (dígito verificador) e aleatórios — evita colidir
// com dados reais de dev e passa no Zod da cadeia.
function randDigits(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('')
}
function genCpf(): string {
  const base = randDigits(9)
  const calc = (slice: string, start: number) => {
    const sum = slice.split('').reduce((acc, d, i) => acc + Number(d) * (start - i), 0)
    const mod = (sum * 10) % 11
    return mod === 10 ? 0 : mod
  }
  const d1 = calc(base, 10)
  const d2 = calc(base + d1, 11)
  return base + String(d1) + String(d2)
}
function genCnpj(): string {
  const base = randDigits(8) + '0001'
  const calc = (slice: string) => {
    const weights = slice.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const sum = slice.split('').reduce((acc, d, i) => acc + Number(d) * weights[i], 0)
    const mod = sum % 11
    return mod < 2 ? 0 : 11 - mod
  }
  const d1 = calc(base)
  const d2 = calc(base + d1)
  return base + String(d1) + String(d2)
}

async function inTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

const createdEntityIds: number[] = []

afterAll(async () => {
  if (createdEntityIds.length) {
    const ids = createdEntityIds.join(',')
    await pool.query(`DELETE FROM setes_central.tb_entity_has_mailing WHERE tb_entity_id IN (${ids})`)
    await pool.query(`DELETE FROM setes_central.tb_person  WHERE id IN (${ids})`)
    await pool.query(`DELETE FROM setes_central.tb_company WHERE id IN (${ids})`)
    await pool.query(`DELETE FROM setes_central.tb_no_doc  WHERE id IN (${ids})`)
    await pool.query(`DELETE FROM setes_central.tb_entity  WHERE id IN (${ids})`)
  }
  await pool.end()
})

function baseInput(over: Partial<SyncEntityInput> & Pick<SyncEntityInput, 'personType'>): SyncEntityInput {
  return {
    entity: { nameCompany: 'TESTE SYNC MOTOR', nickTrade: 'TESTE' },
    person: null, company: null,
    ...over,
  } as SyncEntityInput
}

describe('motor de reindexação (sync.entity)', () => {
  it('critério 2: mesmo CNPJ reenviado NÃO duplica entity (D3)', async () => {
    const cnpj = genCnpj()
    const input = baseInput({ personType: 'J', company: { cnpj } })

    const first = await inTransaction(conn => saveSyncEntity(conn, input))
    createdEntityIds.push(first.entityId)
    expect(first.reused).toBe(false)
    expect(first.externalCode).toBeUndefined()

    // "Outro cliente da Setes" envia o MESMO CNPJ com emp_codigo diferente —
    // o código local nem entra no motor (D3): tem que cair na mesma entity.
    const second = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'J',
        entity: { nameCompany: 'MESMO CNPJ OUTRO CLIENTE', nickTrade: 'OUTRO' },
        company: { cnpj },
      }))
    )
    expect(second.entityId).toBe(first.entityId)
    expect(second.reused).toBe(true)
  })

  it('critério 2 (PF): mesmo CPF reenviado NÃO duplica entity', async () => {
    const cpf = genCpf()
    const first = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'F', person: { cpf } })))
    createdEntityIds.push(first.entityId)

    const second = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'F', person: { cpf } })))
    expect(second.entityId).toBe(first.entityId)
    expect(second.reused).toBe(true)
  })

  it('critério 3: sem documento gera UUID; reenvio com o UUID não duplica (D4)', async () => {
    const first = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'N' })))
    createdEntityIds.push(first.entityId)
    expect(first.externalCode).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.reused).toBe(false)

    // Sincronizador gravou o UUID em tb_empresa.externalCode e REENVIA (D4)
    const second = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'N',
        entity: { nameCompany: 'SEM DOC ATUALIZADO', nickTrade: 'V2' },
        externalCode: first.externalCode,
      })))
    expect(second.entityId).toBe(first.entityId)
    expect(second.externalCode).toBe(first.externalCode)
    expect(second.reused).toBe(true)
  })

  it('externalCode desconhecido → 404 EXTERNAL_CODE_NOT_FOUND', async () => {
    await expect(inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'N',
        externalCode: '00000000-0000-4000-8000-000000000000',
      })))
    ).rejects.toMatchObject({ statusCode: 404, code: 'EXTERNAL_CODE_NOT_FOUND' })
  })

  it('mailings: email deduplicado por UNIQUE + vínculo no grupo', async () => {
    const cnpj = genCnpj()
    const email = `sync.motor.${Date.now()}@teste.dev`
    const result = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'J', company: { cnpj },
        mailings: [{ email, groupId: 1 }],
      })))
    createdEntityIds.push(result.entityId)

    const [rows] = await pool.query<any[]>(
      `SELECT m.email FROM setes_central.tb_entity_has_mailing ehm
       JOIN setes_central.tb_mailing m ON m.id = ehm.tb_mailing_id
       WHERE ehm.tb_entity_id = ? AND ehm.deleted = 'N'`,
      [result.entityId]
    )
    expect(rows.map(r => r.email)).toContain(email)
  })

  it('contrato Zod: máscara removida passa; personType J sem company falha', () => {
    const masked = stripDocumentMasks({
      entity: { nameCompany: 'X', nickTrade: 'X' },
      personType: 'J',
      company: { cnpj: '11.222.333/0001-81' },
    })
    expect(syncEntityBody.safeParse(masked).success).toBe(true)
    expect(syncEntityBody.safeParse({
      entity: { nameCompany: 'X', nickTrade: 'X' }, personType: 'J',
    }).success).toBe(false)
  })
})
