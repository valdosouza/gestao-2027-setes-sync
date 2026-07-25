// Smoke da Onda 4 — papéis de entidade com reindexação (D3/D4/D13)
import app from '../src/app'
import http from 'http'
import fs from 'fs'
import pool from '../src/shared/db/connection'

const key = fs.readFileSync('.dev-sync-key', 'utf8').trim()
const PORT = 3796

function post(path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: 'localhost', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': key } },
      res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(b || '{}') })) }
    )
    req.on('error', reject)
    req.end(data)
  })
}

const results: string[] = []
function check(name: string, cond: boolean, extra = '') {
  results.push(`${cond ? '✓' : '✗ FALHOU'} ${name} ${extra}`)
  if (!cond) process.exitCode = 1
}

// CNPJ/CPF válidos gerados (mesmos geradores do teste do motor)
function randDigits(n: number): string { return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('') }
function genCpf(): string {
  const base = randDigits(9)
  const calc = (s: string, st: number) => { const sum = s.split('').reduce((a, d, i) => a + Number(d) * (st - i), 0); const m = (sum * 10) % 11; return m === 10 ? 0 : m }
  const d1 = calc(base, 10); const d2 = calc(base + d1, 11)
  return base + String(d1) + String(d2)
}
function genCnpj(): string {
  const base = randDigits(8) + '0001'
  const calc = (s: string) => { const w = s.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2]; const sum = s.split('').reduce((a, d, i) => a + Number(d) * w[i], 0); const m = sum % 11; return m < 2 ? 0 : 11 - m }
  const d1 = calc(base); const d2 = calc(base + d1)
  return base + String(d1) + String(d2)
}

const cleanupEntities: number[] = []

const srv = app.listen(PORT, async () => {
  try {
    const cnpj = genCnpj()
    const cpfVend = genCpf()

    // 1. Cliente com vendedor NÃO sincronizado → 409
    const c409 = await post('/customer/sincronize', {
      entity: { nameCompany: 'CLIENTE X', nickTrade: 'X' }, personType: 'J',
      company: { cnpj }, customer: { salesmanDocument: cpfVend } })
    check('cliente c/ vendedor ausente → 409', c409.status === 409 && c409.body.code === 'SALESMAN_NOT_SYNCED')

    // 2. Vendedor (collaborator + salesman na mesma transação)
    const v = await post('/salesman/sincronize', {
      entity: { nameCompany: 'VENDEDOR SMOKE', nickTrade: 'VEND' }, personType: 'F',
      person: { cpf: cpfVend },
      collaborator: { salary: 3000, dtAdmission: '2020-01-01' },
      salesman: { aliqKickback: 2.5 } })
    check('vendedor cria', v.status === 200 && v.body.id > 0, JSON.stringify(v.body))
    cleanupEntities.push(v.body.id)
    const [[collab]] = await pool.query<any[]>(
      `SELECT id FROM setes_setes.tb_collaborator WHERE id = ? AND tb_institution_id = 1`, [v.body.id]) as any
    check('precedência: collaborator criado junto', !!collab)

    // 3. Cliente agora passa (vendedor resolvido por DOCUMENTO)
    const c1 = await post('/customer/sincronize', {
      entity: { nameCompany: 'CLIENTE X', nickTrade: 'X' }, personType: 'J',
      company: { cnpj }, mailings: [{ email: `cli.${Date.now()}@smoke.dev` }],
      customer: { salesmanDocument: cpfVend, creditValue: 1000 },
      entityTax: { consumer: 'S', byPassSt: 'N' } })
    check('cliente cria (vendedor por documento)', c1.status === 200 && c1.body.id > 0)
    cleanupEntities.push(c1.body.id)
    const [[cust]] = await pool.query<any[]>(
      `SELECT tb_salesman_id FROM setes_setes.tb_customer WHERE id = ? AND tb_institution_id = 1`, [c1.body.id]) as any
    check('tb_salesman_id = entity do vendedor', Number(cust?.tb_salesman_id) === v.body.id)
    const [[tax]] = await pool.query<any[]>(
      `SELECT consumer FROM setes_setes.tb_entity_tax WHERE id = ? AND tb_institution_id = 1`, [c1.body.id]) as any
    check('entity_tax gravada', tax?.consumer === 'S')

    // 4. CALCANHAR DE AQUILES: o MESMO CNPJ chega como FORNECEDOR → mesma entity, 2 papéis
    const p1 = await post('/provider/sincronize', {
      entity: { nameCompany: 'CLIENTE X COMO FORNECEDOR', nickTrade: 'X' }, personType: 'J',
      company: { cnpj }, provider: { active: 'S' } })
    check('fornecedor mesmo CNPJ → MESMA entity (D3)', p1.status === 200 && p1.body.id === c1.body.id,
      `customer=${c1.body.id} provider=${p1.body.id}`)
    const [[roles]] = await pool.query<any[]>(
      `SELECT (SELECT COUNT(*) FROM setes_setes.tb_customer WHERE id = ?) c,
              (SELECT COUNT(*) FROM setes_setes.tb_provider WHERE id = ?) p`,
      [c1.body.id, c1.body.id]) as any
    check('1 entity, 2 papéis', Number(roles.c) === 1 && Number(roles.p) === 1)

    // 5. Cliente SEM documento → UUID; reenvio com UUID não duplica
    const n1 = await post('/customer/sincronize', {
      entity: { nameCompany: 'CLIENTE SEM DOC', nickTrade: 'SD' }, personType: 'N',
      customer: {} })
    check('sem doc devolve externalCode', n1.status === 200 && /^[0-9a-f-]{36}$/.test(n1.body.externalCode))
    cleanupEntities.push(n1.body.id)
    const n2 = await post('/customer/sincronize', {
      entity: { nameCompany: 'CLIENTE SEM DOC V2', nickTrade: 'SD' }, personType: 'N',
      externalCode: n1.body.externalCode, customer: {} })
    check('reenvio com UUID não duplica', n2.status === 200 && n2.body.id === n1.body.id)

    // 6. Conta bancária: banco por número FEBRABAN + 409 de desconhecido
    const ba409 = await post('/bank-account/sincronize', { id: 990, bankNumber: '999' })
    check('banco desconhecido → 409', ba409.status === 409 && ba409.body.code === 'BANK_NOT_FOUND')
    const [[bank]] = await pool.query<any[]>(
      `SELECT number FROM setes_central.tb_bank WHERE deleted = 'N' LIMIT 1`) as any
    if (bank) {
      const ba = await post('/bank-account/sincronize', {
        id: 990, bankNumber: bank.number, agency: '1234', number: '55555', limitValue: 1000 })
      check(`conta cria (banco ${bank.number})`, ba.status === 200 && ba.body.id === 990)
      await pool.query(`DELETE FROM setes_setes.tb_bank_account WHERE id = 990 AND tb_institution_id = 1`)
    } else {
      results.push('… tb_bank vazia — seed sql/17 não aplicado; pulei o caso positivo')
    }
  } catch (e: any) {
    results.push('SMOKE ERRO: ' + e.message)
    process.exitCode = 1
  } finally {
    try {
      if (cleanupEntities.length) {
        const ids = cleanupEntities.join(',')
        await pool.query(`DELETE FROM setes_setes.tb_entity_tax WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_setes.tb_customer WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_setes.tb_provider WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_setes.tb_salesman WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_setes.tb_collaborator WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_entity_has_mailing WHERE tb_entity_id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_person WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_company WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_no_doc WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_entity WHERE id IN (${ids})`)
      }
    } catch (e: any) { results.push('LIMPEZA ERRO: ' + e.message) }
    console.log(results.join('\n'))
    srv.close()
    await pool.end()
    process.exit(process.exitCode ?? 0)
  }
})
