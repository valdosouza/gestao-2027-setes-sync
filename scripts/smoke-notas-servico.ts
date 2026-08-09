// Smoke — Notas de Mercadoria × Serviço (prompt_notas_mercadoria_servico.md, 2026-07-26)
// Ciclo: produto S (/service) + 422 no /merchandise → pedido CONJUGADO
// (order-sale + order-service no MESMO id) → snapshot escopado por kind →
// nota conjugada (invoice-merchandise + invoice-service, ramos no MESMO id).
import app from '../src/app'
import http from 'http'
import fs from 'fs'
import pool from '../src/shared/db/connection'

const key = fs.readFileSync('.dev-sync-key', 'utf8').trim()
const PORT = 3793

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

const entities: number[] = []
const ORDER = 8901, CAT = 8902, PRODM = 8903, PRODS = 8904, TERM = 0

const srv = app.listen(PORT, async () => {
  try {
    const cpfV = genCpf(), cnpjC = genCnpj()

    // Pré-requisitos: vendedor, cliente, categoria, produto mercadoria
    const v = await post('/salesman/sincronize', {
      entity: { nameCompany: 'VEND NS', nickTrade: 'V' }, personType: 'F', person: { cpf: cpfV }, salesman: {} })
    const c = await post('/customer/sincronize', {
      entity: { nameCompany: 'CLI NS', nickTrade: 'C' }, personType: 'J', company: { cnpj: cnpjC }, customer: {} })
    entities.push(v.body.id, c.body.id)
    await post('/category/sincronize', { id: CAT, description: 'CAT NS', kind: 'P' })
    const pm = await post('/merchandise/sincronize', {
      id: PRODM, product: { kind: 'P', description: 'PECA NS', categoryId: CAT } })
    check('pré-requisitos ok', v.status === 200 && c.status === 200 && pm.status === 200)

    // 1. D2 — /merchandise recusa serviço; /service grava só tb_product kind='S'
    const m422 = await post('/merchandise/sincronize', {
      id: PRODS, product: { kind: 'S', description: 'SRV NS', categoryId: CAT } })
    check('merchandise kind S → 422 KIND_NOT_ALLOWED', m422.status === 422 && m422.body.code === 'KIND_NOT_ALLOWED')
    const ps = await post('/service/sincronize', {
      id: PRODS, product: { description: 'TROCA DE OLEO NS', categoryId: CAT } })
    check('service cria produto S', ps.status === 200, JSON.stringify(ps.body))
    const [[prodS]] = await pool.query<any[]>(
      `SELECT kind FROM setes_setes.tb_product WHERE id = ${PRODS} AND tb_institution_id = 1`) as any
    const [merchRows] = await pool.query<any[]>(
      `SELECT id FROM setes_setes.tb_merchandise WHERE id = ${PRODS} AND tb_institution_id = 1`) as any
    check('produto S sem especialização', prodS?.kind === 'S' && merchRows.length === 0)
    const [[prodM]] = await pool.query<any[]>(
      `SELECT kind FROM setes_setes.tb_product WHERE id = ${PRODM} AND tb_institution_id = 1`) as any
    check('produto P com kind gravado', prodM?.kind === 'P')

    // 2. D13 — pedido CONJUGADO entra INTEIRO por UM envio no /order-service:
    // ramos service+sale, itens dos dois kinds e nota com os DOIS ramos
    const osv = await post('/order-service/sincronize', {
      id: ORDER, terminal: TERM,
      order: { dtRecord: '2026-07-26', status: 'A' },
      service: { number: 55, customerDocument: cnpjC },
      items: [{ id: 2, productId: PRODS, quantity: 1, unitValue: 80 }],
      sale: { number: 55, salesmanDocument: cpfV },
      saleItems: [{ id: 1, productId: PRODM, quantity: 2, unitValue: 9.9 }],
      totalizer: { itemsQtde: 2, productQtde: 3, productValue: 19.8, totalValue: 99.8 },
      billing: { paymentTypeDescription: `PGTO NS ${Date.now() % 10000}`, plots: '1', deadline: '30' },
      invoice: { kindEmis: 'SE', number: '000124', dtEmission: '2026-07-26', value: 99.8,
                 model: '55', entityDocument: cnpjC, issuer: 'S',
                 service: { totalValue: 80 },
                 merchandise: { totalValue: 19.8, discountValue: 0, indPres: 1, totalQtty: 3 } } })
    check('order-service CONJUGADA completa em 1 envio', osv.status === 200, JSON.stringify(osv.body))
    // Reenvio do lado service (sem saleItems) não pode derrubar o lado Sale
    const os = await post('/order-service/sincronize', {
      id: ORDER, terminal: TERM,
      service: { number: 55, customerDocument: cnpjC },
      items: [{ id: 2, productId: PRODS, quantity: 1, unitValue: 80 }] })
    check('reenvio parcial preserva ramo/itens Sale', os.status === 200, JSON.stringify(os.body))
    const [orderRows] = await pool.query<any[]>(
      `SELECT id FROM setes_setes.tb_order WHERE id = ${ORDER} AND tb_institution_id = 1 AND terminal = ${TERM}`) as any
    const [[saleRow]] = await pool.query<any[]>(
      `SELECT tb_customer_id FROM setes_setes.tb_order_sale WHERE id = ${ORDER} AND tb_institution_id = 1`) as any
    const [[svcRow]] = await pool.query<any[]>(
      `SELECT tb_customer_id, open_lock FROM setes_setes.tb_order_service WHERE id = ${ORDER} AND tb_institution_id = 1`) as any
    const [itemRows] = await pool.query<any[]>(
      `SELECT id, kind FROM setes_setes.tb_order_item
       WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1 AND deleted = 'N' ORDER BY kind`) as any
    check('conjugado: 1 order + 2 ramos + itens Sale/Service',
      orderRows.length === 1 && !!saleRow && !!svcRow && svcRow.open_lock === null &&
      itemRows.length === 2 && itemRows.some((i: any) => i.kind === 'Sale') && itemRows.some((i: any) => i.kind === 'Service'))

    // 3. Snapshots ESCOPADOS: atualizar só os saleItems não pode tocar os Service
    const os2 = await post('/order-service/sincronize', {
      id: ORDER, terminal: TERM,
      service: { number: 55, customerDocument: cnpjC },
      sale: { number: 55, salesmanDocument: cpfV },
      saleItems: [{ id: 1, productId: PRODM, quantity: 3, unitValue: 9.9 }] })
    const [itemsAfter] = await pool.query<any[]>(
      `SELECT id, kind FROM setes_setes.tb_order_item
       WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1 AND deleted = 'N'`) as any
    check('snapshot de saleItems preserva itens Service',
      os2.status === 200 && itemsAfter.length === 2 && itemsAfter.some((i: any) => i.kind === 'Service'))

    // 4. D3 + rodada 2 — a nota conjugada nasceu DOS ENDPOINTS DE PROCESSO:
    // 1 invoice + 2 ramos no mesmo id, sem chamar os canais de nota isolada
    const [invRows] = await pool.query<any[]>(
      `SELECT id FROM setes_setes.tb_invoice WHERE id = ${ORDER} AND tb_institution_id = 1`) as any
    const [[ramoM]] = await pool.query<any[]>(
      `SELECT total_value FROM setes_setes.tb_invoice_merchandise WHERE id = ${ORDER} AND tb_institution_id = 1`) as any
    const [[ramoS]] = await pool.query<any[]>(
      `SELECT total_value FROM setes_setes.tb_invoice_service WHERE id = ${ORDER} AND tb_institution_id = 1`) as any
    check('nota conjugada via processo: 1 invoice + 2 ramos',
      invRows.length === 1 && Number(ramoM?.total_value) === 19.8 && Number(ramoS?.total_value) === 80)
    // Canal de nota isolada (D10) permanece: reenvio avulso da nota de mercadoria
    const invM = await post('/invoice-merchandise/sincronize', {
      id: ORDER, terminal: TERM, kindEmis: 'SE', number: '000124', dtEmission: '2026-07-26',
      value: 99.8, model: '55', entityDocument: cnpjC, issuer: 'S',
      merchandise: { totalValue: 19.8, discountValue: 0, indPres: 1, totalQtty: 3 } })
    check('canal isolado /invoice-merchandise segue vivo', invM.status === 200, JSON.stringify(invM.body))

    // 5. Vínculo pela PK: nota de serviço sem pedido → 409 ORDER_NOT_SYNCED
    const inv409 = await post('/invoice-service/sincronize', {
      id: 77777, terminal: TERM, kindEmis: 'SE', number: '000125', dtEmission: '2026-07-26', value: 1 })
    check('invoice-service pedido ausente → 409', inv409.status === 409 && inv409.body.code === 'ORDER_NOT_SYNCED')
  } catch (e: any) {
    results.push('SMOKE ERRO: ' + e.message)
    process.exitCode = 1
  } finally {
    try {
      await pool.query(`DELETE FROM setes_setes.tb_invoice_service WHERE id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_invoice_merchandise WHERE id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_invoice WHERE id = ${ORDER} AND tb_institution_id = 1`)
      for (const t of ['tb_order_billing', 'tb_order_totalizer', 'tb_order_service', 'tb_order_sale']) {
        await pool.query(`DELETE FROM setes_setes.${t} WHERE id = ${ORDER} AND tb_institution_id = 1`)
      }
      await pool.query(`DELETE FROM setes_setes.tb_order_item_merchandise WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_order_item WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_order WHERE id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_stock WHERE tb_merchandise_id IN (${PRODM}, ${PRODS}) AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_merchandise WHERE id IN (${PRODM}, ${PRODS}) AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_product WHERE id IN (${PRODM}, ${PRODS}) AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_category WHERE id = ${CAT} AND tb_institution_id = 1`)
      await pool.query(`DELETE l FROM setes_setes.tb_institution_has_payment_types l JOIN setes_central.tb_payment_types c ON c.id = l.tb_payment_types_id WHERE c.description LIKE 'PGTO NS %'`)
      await pool.query(`DELETE FROM setes_central.tb_payment_types WHERE description LIKE 'PGTO NS %'`)
      if (entities.length) {
        const ids = entities.join(',')
        await pool.query(`DELETE FROM setes_setes.tb_customer WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_setes.tb_salesman WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_setes.tb_collaborator WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_person WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_company WHERE id IN (${ids})`)
        await pool.query(`DELETE FROM setes_central.tb_entity WHERE id IN (${ids})`)
      }
    } catch (e: any) { results.push('LIMPEZA ERRO: ' + e.message) }
    console.log(results.join('\n'))
    srv.close()
    await pool.end()
    process.exit(process.exitCode ?? 0)
  }
})
