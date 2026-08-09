import pool from '@shared/db/connection'
import { PoolConnection } from 'mysql2/promise'
import {
  saveSyncEntity, syncEntityBody, stripDocumentMasks, SyncEntityInput,
  resolveSentinelRole,
} from '@modules/sync/sync.entity'

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
    await pool.query(`DELETE FROM setes_central.tb_address WHERE id IN (${ids})`)
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

  it('fallback geográfico: trio inexistente cai para o trio do institution (decisão 2026-08-01)', async () => {
    // Trio VÁLIDO qualquer da referência central (seed 06 garante ≥1 cidade)
    const [geo] = await pool.query<any[]>(
      `SELECT ci.id AS city, ci.tb_state_id AS state, st.tb_country_id AS country
       FROM setes_central.tb_city ci
       JOIN setes_central.tb_state st ON st.id = ci.tb_state_id
       LIMIT 1`)
    expect(geo.length).toBe(1)
    const trio = geo[0]

    // "Institution": entity com endereço main usando o trio válido (herança
    // por PK — o id da entity é o que o fallback consulta)
    const inst = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'N',
        addresses: [{ kind: 'COMERCIAL', street: 'RUA DO INSTITUTION',
          tbCountryId: trio.country, tbStateId: trio.state, tbCityId: trio.city, main: 'S' }],
      })))
    createdEntityIds.push(inst.entityId)

    // Cliente com cidade INEXISTENTE → endereço cai para o trio do institution
    const cust = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'F', person: { cpf: genCpf() },
        addresses: [{ kind: 'COMERCIAL', street: 'RUA DO CLIENTE',
          tbCountryId: trio.country, tbStateId: trio.state, tbCityId: 999999999, main: 'S' }],
      }), { origin: 'test-geo', institutionId: inst.entityId }))
    createdEntityIds.push(cust.entityId)

    const [rows] = await pool.query<any[]>(
      `SELECT tb_country_id AS country, tb_state_id AS state, tb_city_id AS city
       FROM setes_central.tb_address WHERE id = ? AND deleted = 'N'`, [cust.entityId])
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ country: trio.country, state: trio.state, city: trio.city })
  })

  it('sentinelas da opção b: CONSUMIDOR FINAL/VENDEDOR PADRAO idempotentes por institution', async () => {
    const custA = await inTransaction(conn =>
      resolveSentinelRole(conn, 1, 'setes_setes', 'customer'))
    const custB = await inTransaction(conn =>
      resolveSentinelRole(conn, 1, 'setes_setes', 'customer'))
    expect(custB).toBe(custA) // reuso pelo nome + sem-doc — nunca duplica

    const salesman = await inTransaction(conn =>
      resolveSentinelRole(conn, 1, 'setes_setes', 'salesman'))
    expect(salesman).not.toBe(custA)

    createdEntityIds.push(custA, salesman)
    await pool.query('DELETE FROM setes_setes.tb_customer WHERE id = ?', [custA])
    await pool.query('DELETE FROM setes_setes.tb_salesman WHERE id = ?', [salesman])
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

  // -------------------------------------------------------------------
  // Graduação do sem-doc (prompt_correcao_documento_entidade.md, 2026-07-25)
  // -------------------------------------------------------------------

  it('graduação (caso A): sem-doc corrigido MANTÉM o tb_entity.id e pede limpeza', async () => {
    const noDoc = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'N' })))
    createdEntityIds.push(noDoc.entityId)

    const cpf = genCpf()
    const graduated = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'F', person: { cpf },
        externalCode: noDoc.externalCode,
      })))

    expect(graduated.entityId).toBe(noDoc.entityId)          // histórico intacto
    expect(graduated.clearExternalCode).toBe(true)           // decisão 1

    const [person] = await pool.query<any[]>(
      `SELECT cpf FROM setes_central.tb_person WHERE id = ? AND deleted = 'N'`, [noDoc.entityId])
    expect(person[0]?.cpf).toBe(cpf)
    const [nodoc] = await pool.query<any[]>(
      `SELECT deleted FROM setes_central.tb_no_doc WHERE id = ?`, [noDoc.entityId])
    expect(nodoc[0]?.deleted).toBe('S')                      // toggle soft-deletou
  })

  it('graduação (caso B): regravação pós-graduação é idempotente e pede limpeza de novo', async () => {
    const noDoc = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'N' })))
    createdEntityIds.push(noDoc.entityId)
    const cpf = genCpf()
    const payload = baseInput({
      personType: 'F', person: { cpf }, externalCode: noDoc.externalCode,
    })
    await inTransaction(conn => saveSyncEntity(conn, payload))
    // Firebird ainda não limpou o EXTERNALCODE e reenvia o mesmo payload
    const again = await inTransaction(conn => saveSyncEntity(conn, payload))
    expect(again.entityId).toBe(noDoc.entityId)
    expect(again.clearExternalCode).toBe(true)
  })

  it('graduação (caso C): documento de OUTRA entity NUNCA mescla — segue sem-doc', async () => {
    const cpf = genCpf()
    const dono = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'F', person: { cpf } })))
    createdEntityIds.push(dono.entityId)
    const noDoc = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'N' })))
    createdEntityIds.push(noDoc.entityId)

    const conflicted = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'F', person: { cpf },                    // cpf do "dono"
        externalCode: noDoc.externalCode,
      })))

    expect(conflicted.entityId).toBe(noDoc.entityId)         // segue na entity do externalCode
    expect(conflicted.clearExternalCode).toBeUndefined()     // vínculo mantido
    const [nodoc] = await pool.query<any[]>(
      `SELECT deleted FROM setes_central.tb_no_doc WHERE id = ?`, [noDoc.entityId])
    expect(nodoc[0]?.deleted).toBe('N')                      // continua sem-doc
    const [person] = await pool.query<any[]>(
      `SELECT id FROM setes_central.tb_person WHERE id = ?`, [noDoc.entityId])
    expect(person.length).toBe(0)                            // documento NÃO gravado nela
  })

  it('graduação (caso D1): órfão com documento LIVRE segue por documento + limpeza', async () => {
    const cpf = genCpf()
    const result = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'F', person: { cpf },
        externalCode: '00000000-0000-4000-8000-000000000001',
      })))
    createdEntityIds.push(result.entityId)
    expect(result.clearExternalCode).toBe(true)
  })

  it('graduação (caso D2): órfão com documento OCUPADO → 409 EXTERNAL_CODE_ORPHAN', async () => {
    const cpf = genCpf()
    const dono = await inTransaction(conn =>
      saveSyncEntity(conn, baseInput({ personType: 'F', person: { cpf } })))
    createdEntityIds.push(dono.entityId)

    await expect(inTransaction(conn =>
      saveSyncEntity(conn, baseInput({
        personType: 'F', person: { cpf },
        externalCode: '00000000-0000-4000-8000-000000000002',
      })))
    ).rejects.toMatchObject({ statusCode: 409, code: 'EXTERNAL_CODE_ORPHAN' })
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
