// Smoke da Onda 5 — movimento: venda → financeiro → extrato → nota → caixa
import app from '../src/app'
import http from 'http'
import fs from 'fs'
import pool from '../src/shared/db/connection'

const key = fs.readFileSync('.dev-sync-key', 'utf8').trim()
const PORT = 3795

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
const ORDER = 8801, CAT = 8802, PROD = 8803, CAIXA = 8804, NOTA = 8805, MOV = 8806, TERM = 0

const srv = app.listen(PORT, async () => {
  try {
    const cpfV = genCpf(), cnpjC = genCnpj()

    // Pré-requisitos: vendedor, cliente, categoria, produto
    const v = await post('/salesman/sincronize', {
      entity: { nameCompany: 'VEND O5', nickTrade: 'V' }, personType: 'F', person: { cpf: cpfV },
      salesman: {} })
    const c = await post('/customer/sincronize', {
      entity: { nameCompany: 'CLI O5', nickTrade: 'C' }, personType: 'J', company: { cnpj: cnpjC },
      customer: {} })
    entities.push(v.body.id, c.body.id)
    await post('/category/sincronize', { id: CAT, description: 'CAT O5', kind: 'P' })
    const p = await post('/merchandise/sincronize', {
      id: PROD, product: { description: 'PROD O5', categoryId: CAT } })
    check('pré-requisitos ok', v.status === 200 && c.status === 200 && p.status === 200)

    // 1. Pedido de venda completo
    const os = await post('/order-sale/sincronize', {
      id: ORDER, terminal: TERM,
      order: { dtRecord: '2026-07-19', status: 'A' },
      sale: { number: 55, customerDocument: cnpjC, salesmanDocument: cpfV },
      items: [{ id: 1, productId: PROD, quantity: 2, unitValue: 9.9 }],
      totalizer: { itemsQtde: 1, productQtde: 2, productValue: 19.8, totalValue: 19.8 },
      billing: { paymentTypeDescription: `PGTO O5 ${Date.now() % 10000}`, plots: '1', deadline: '30' } })
    check('order-sale cria', os.status === 200 && os.body.id === ORDER, JSON.stringify(os.body))

    // 2. Financeiro: título sem pedido → 409; com pedido + baixa → grava título e evento
    const f409 = await post('/financial/sincronize', {
      orderId: 77777, terminal: TERM, parcel: 1, dtExpiration: '2026-08-19', tagValue: 19.8 })
    check('financial pedido ausente → 409', f409.status === 409 && f409.body.code === 'ORDER_NOT_SYNCED')
    const f1 = await post('/financial/sincronize', {
      orderId: ORDER, terminal: TERM, parcel: 1, dtExpiration: '2026-08-19', tagValue: 19.8,
      payment: { paidValue: 19.8, dtPayment: '2026-07-19', settledCode: 7 } })
    check('financial título + baixa espelhada', f1.status === 200)
    const [[pay]] = await pool.query<any[]>(
      `SELECT status, settled, paid_value FROM setes_setes.tb_financial_payment
       WHERE tb_order_id = ? AND tb_institution_id = 1 AND parcel = 1 AND event = 1`, [ORDER]) as any
    check('payment evento 1 status N', pay?.status === 'N' && pay?.settled === 'S' && Number(pay?.paid_value) === 19.8)

    // 3. Extrato (statement)
    const st = await post('/financial-statement/sincronize', {
      id: MOV, terminal: TERM, dtRecord: '2026-07-19', creditValue: 19.8, kind: 'C', settledCode: 7 })
    check('financial-statement', st.status === 200)

    // 4. Nota fiscal avulsa + de mercadoria (vínculo validado com o pedido)
    const inv = await post('/invoice/sincronize', {
      id: NOTA, terminal: TERM, kindEmis: 'EM', number: '000123', dtEmission: '2026-07-19',
      value: 19.8, model: '55' })
    check('invoice avulsa', inv.status === 200, JSON.stringify(inv.body))
    const invM = await post('/invoice-merchandise/sincronize', {
      id: NOTA + 1, terminal: TERM, kindEmis: 'SM', number: '000124', dtEmission: '2026-07-19',
      value: 19.8, model: '55', orderId: ORDER, entityDocument: cnpjC, issuer: 'S' })
    check('invoice-merchandise (pedido validado)', invM.status === 200, JSON.stringify(invM.body))
    const invM409 = await post('/invoice-merchandise/sincronize', {
      id: NOTA + 2, terminal: TERM, kindEmis: 'SM', number: '000125', dtEmission: '2026-07-19',
      value: 1, orderId: 77777 })
    check('invoice-merchandise pedido ausente → 409', invM409.status === 409)

    // 5. Movimentação de estoque + caixa
    const ss = await post('/stock-statement/sincronize', {
      id: 8807, terminal: TERM, merchandiseId: PROD, dtRecord: '2026-07-19',
      direction: 'S', quantity: 2, orderId: ORDER })
    check('stock-statement', ss.status === 200, JSON.stringify(ss.body))
    const cx = await post('/cashier/sincronize', {
      id: CAIXA, terminal: TERM, dtRecord: '2026-07-19', hrBegin: '2026-07-19 08:00:00' })
    check('cashier', cx.status === 200)

    // 6. Compra com fornecedor não sincronizado → 409
    const op409 = await post('/order-purchase/sincronize', {
      id: ORDER + 1, terminal: TERM, order: { dtRecord: '2026-07-19' },
      purchase: { number: 1, providerDocument: genCnpj() },
      items: [{ id: 1, productId: PROD, quantity: 1, unitValue: 5 }] })
    check('order-purchase fornecedor ausente → 409', op409.status === 409 && op409.body.code === 'PROVIDER_NOT_SYNCED')
  } catch (e: any) {
    results.push('SMOKE ERRO: ' + e.message)
    process.exitCode = 1
  } finally {
    try {
      await pool.query(`DELETE FROM setes_setes.tb_financial_payment WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_financial WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_financial_statement WHERE id = ${MOV} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_invoice WHERE id IN (${NOTA}, ${NOTA + 1}) AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_stock_statement WHERE id = 8807 AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_cashier WHERE id = ${CAIXA} AND tb_institution_id = 1`)
      for (const t of ['tb_order_billing', 'tb_order_totalizer']) {
        await pool.query(`DELETE FROM setes_setes.${t} WHERE id = ${ORDER} AND tb_institution_id = 1`)
      }
      await pool.query(`DELETE FROM setes_setes.tb_order_item_merchandise WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_order_item WHERE tb_order_id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_order_sale WHERE id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_order WHERE id = ${ORDER} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_stock WHERE tb_merchandise_id = ${PROD} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_merchandise WHERE id = ${PROD} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_product WHERE id = ${PROD} AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_category WHERE id = ${CAT} AND tb_institution_id = 1`)
      await pool.query(`DELETE l FROM setes_setes.tb_institution_has_payment_types l JOIN setes_central.tb_payment_types c ON c.id = l.tb_payment_types_id WHERE c.description LIKE 'PGTO O5 %'`)
      await pool.query(`DELETE FROM setes_central.tb_payment_types WHERE description LIKE 'PGTO O5 %'`)
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
