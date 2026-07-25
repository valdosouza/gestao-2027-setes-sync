// Smoke de CICLO COMPLETO da Onda 3 — todos os 12 endpoints de cadastro
import app from '../src/app'
import http from 'http'
import fs from 'fs'
import pool from '../src/shared/db/connection'

const key = fs.readFileSync('.dev-sync-key', 'utf8').trim()
const PORT = 3797

function post(path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: 'localhost', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': key } },
      res => {
        let b = ''
        res.on('data', d => (b += d))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(b || '{}') }))
      }
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

const srv = app.listen(PORT, async () => {
  const S = Date.now() % 100000
  const PROD = 950, CAT = 951, PL = 952, SL = 953, FP = 954, PROMO = 955
  try {
    // 1. Categoria raiz
    const cat = await post('/category/sincronize', { id: CAT, description: `CAT CICLO ${S}`, kind: 'P' })
    check('categoria', cat.status === 200)

    // 2. Produto SEM categoria sincronizada → 409
    const p409 = await post('/merchandise/sincronize', {
      id: PROD, product: { description: 'X', categoryId: 88888 } })
    check('produto categoria ausente → 409', p409.status === 409 && p409.body.code === 'CATEGORY_NOT_SYNCED')

    // 3. Produto completo (marca/embalagem/medida por DESCRIÇÃO)
    const prod = await post('/merchandise/sincronize', {
      id: PROD,
      product: { description: `PRODUTO CICLO ${S}`, categoryId: CAT },
      merchandise: { nameBrand: `MARCA CICLO ${S}`, ncm: '22021000' },
      stock: { namePackage: `EMB CICLO ${S}`, nameMeasure: `MED CICLO ${S}`, codebar: '789000' },
    })
    check('produto cria + resolve catálogos', prod.status === 200 && prod.body.id === PROD, JSON.stringify(prod.body))

    // marca central + vínculo criados?
    const [[brand]] = await pool.query<any[]>(
      `SELECT b.id FROM setes_central.tb_brand b WHERE b.description = ?`, [`MARCA CICLO ${S}`]) as any
    check('marca criada na central pelo produto', !!brand)

    // 4. Tabela de preço + preço
    const pl = await post('/price-list/sincronize', { id: PL, description: `TAB CICLO ${S}` })
    check('price-list', pl.status === 200)
    const pr = await post('/price/sincronize', { priceListId: PL, productId: PROD, priceTag: 9.9 })
    check('price', pr.status === 200)
    const pr409 = await post('/price/sincronize', { priceListId: 88888, productId: PROD, priceTag: 1 })
    check('price tabela ausente → 409', pr409.status === 409 && pr409.body.code === 'PRICE_LIST_NOT_SYNCED')

    // 5. Lista de estoque + saldo
    const sl = await post('/stock-list/sincronize', { id: SL, description: `ESTOQUE CICLO ${S}`, main: 'S' })
    check('stock-list', sl.status === 200)
    const sb = await post('/stock-balance/sincronize', { stockListId: SL, merchandiseId: PROD, quantity: 42 })
    check('stock-balance', sb.status === 200)
    const [[bal]] = await pool.query<any[]>(
      `SELECT quantity FROM setes_setes.tb_stock_balance WHERE tb_stock_list_id = ? AND tb_merchandise_id = ?`,
      [SL, PROD]) as any
    check('saldo gravado', Number(bal?.quantity) === 42, String(bal?.quantity))

    // 6. Plano de contas em árvore
    const fp1 = await post('/financial-plans/sincronize', {
      id: FP, description: `PLANO CICLO ${S}`, source: 'C', kind: 'C', cluster: 'S' })
    const fp2 = await post('/financial-plans/sincronize', {
      id: FP + 1, description: `PLANO FILHO ${S}`, parentId: FP, source: 'C', kind: 'C', cluster: 'A' })
    check('financial-plans árvore', fp1.status === 200 && fp2.status === 200)
    const [[fpRow]] = await pool.query<any[]>(
      `SELECT posit_level FROM setes_setes.tb_financial_plans WHERE id = ? AND tb_institution_id = 1`,
      [FP + 1]) as any
    check('posit_level recalculado', fpRow?.posit_level === `${FP}.${FP + 1}`, fpRow?.posit_level)

    // 7. Forma de pagamento (dedupe + vínculo com attrs)
    const pt1 = await post('/payment-type/sincronize', { description: `PGTO CICLO ${S}`, idNfce: '03', maxParcels: 3 })
    const pt2 = await post('/payment-type/sincronize', { description: `pgto ciclo ${S}` })
    check('payment-type dedupe', pt1.status === 200 && pt2.status === 200 && pt1.body.id === pt2.body.id)

    // 8. Promoção com item
    const promo = await post('/promotion/sincronize', {
      id: PROMO, description: `PROMO CICLO ${S}`, items: [{ productId: PROD }] })
    check('promotion + item', promo.status === 200)

    // 9. Soft delete do produto (D2)
    const del = await post('/merchandise/sincronize', {
      id: PROD, deleted: 'S', product: { description: `PRODUTO CICLO ${S}`, categoryId: CAT } })
    const [[prodRow]] = await pool.query<any[]>(
      `SELECT deleted FROM setes_setes.tb_product WHERE id = ? AND tb_institution_id = 1`, [PROD]) as any
    check('soft delete produto', del.status === 200 && prodRow?.deleted === 'S')
  } catch (e: any) {
    results.push('SMOKE ERRO: ' + e.message)
    process.exitCode = 1
  } finally {
    // Limpeza (ordem respeita FKs)
    try {
      await pool.query(`DELETE FROM setes_setes.tb_promotion_items WHERE tb_promotion_id = ? AND tb_institution_id = 1`, [PROMO])
      await pool.query(`DELETE FROM setes_setes.tb_promotion WHERE id = ? AND tb_institution_id = 1`, [PROMO])
      await pool.query(`DELETE FROM setes_setes.tb_stock_balance WHERE tb_merchandise_id = ? AND tb_institution_id = 1`, [PROD])
      await pool.query(`DELETE FROM setes_setes.tb_stock_list WHERE id = ? AND tb_institution_id = 1`, [SL])
      await pool.query(`DELETE FROM setes_setes.tb_price WHERE tb_product_id = ? AND tb_institution_id = 1`, [PROD])
      await pool.query(`DELETE FROM setes_setes.tb_price_list WHERE id = ? AND tb_institution_id = 1`, [PL])
      await pool.query(`DELETE FROM setes_setes.tb_stock WHERE tb_merchandise_id = ? AND tb_institution_id = 1`, [PROD])
      await pool.query(`DELETE FROM setes_setes.tb_merchandise WHERE id = ? AND tb_institution_id = 1`, [PROD])
      await pool.query(`DELETE FROM setes_setes.tb_product WHERE id = ? AND tb_institution_id = 1`, [PROD])
      await pool.query(`DELETE FROM setes_setes.tb_category WHERE id = ? AND tb_institution_id = 1`, [CAT])
      await pool.query(`DELETE FROM setes_setes.tb_financial_plans WHERE id IN (?, ?) AND tb_institution_id = 1`, [FP, FP + 1])
      const likes = [`MARCA CICLO ${S}`, `EMB CICLO ${S}`, `MED CICLO ${S}`, `PGTO CICLO ${S}`]
      await pool.query(`DELETE l FROM setes_setes.tb_institution_has_brand l JOIN setes_central.tb_brand c ON c.id = l.tb_brand_id WHERE c.description = ?`, [likes[0]])
      await pool.query(`DELETE l FROM setes_setes.tb_institution_has_package l JOIN setes_central.tb_package c ON c.id = l.tb_package_id WHERE c.description = ?`, [likes[1]])
      await pool.query(`DELETE l FROM setes_setes.tb_institution_has_measure l JOIN setes_central.tb_measure c ON c.id = l.tb_measure_id WHERE c.description = ?`, [likes[2]])
      await pool.query(`DELETE l FROM setes_setes.tb_institution_has_payment_types l JOIN setes_central.tb_payment_types c ON c.id = l.tb_payment_types_id WHERE c.description = ?`, [likes[3]])
      await pool.query(`DELETE FROM setes_central.tb_brand WHERE description = ?`, [likes[0]])
      await pool.query(`DELETE FROM setes_central.tb_package WHERE description = ?`, [likes[1]])
      await pool.query(`DELETE FROM setes_central.tb_measure WHERE description = ?`, [likes[2]])
      await pool.query(`DELETE FROM setes_central.tb_payment_types WHERE description = ?`, [likes[3]])
    } catch (e: any) {
      results.push('LIMPEZA ERRO: ' + e.message)
    }
    console.log(results.join('\n'))
    srv.close()
    await pool.end()
    process.exit(process.exitCode ?? 0)
  }
})
