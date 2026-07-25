// Smoke da Onda 3 — catálogos centrais (D5/D17) + árvore por id local
import app from '../src/app'
import http from 'http'
import fs from 'fs'
import pool from '../src/shared/db/connection'

const key = fs.readFileSync('.dev-sync-key', 'utf8').trim()
const PORT = 3798

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
  try {
    const stamp = Date.now() % 100000

    // Marca: criar + dedupe (case-insensitive) + soft delete do vínculo
    const b1 = await post('/brand/sincronize', { description: `MARCA SMOKE ${stamp}` })
    check('brand cria', b1.status === 200 && b1.body.ok === true && b1.body.id > 0, JSON.stringify(b1.body))
    const b2 = await post('/brand/sincronize', { description: `marca smoke ${stamp}` })
    check('brand dedupe case-insensitive', b2.status === 200 && b2.body.id === b1.body.id)
    const b3 = await post('/brand/sincronize', { description: `MARCA SMOKE ${stamp}`, deleted: 'S' })
    check('brand soft delete vínculo', b3.status === 200)
    const [[link]] = await pool.query<any[]>(
      `SELECT active FROM setes_setes.tb_institution_has_brand WHERE tb_brand_id = ?`, [b1.body.id]) as any
    check('vínculo desativado (linha central fica)', link?.active === 'N')

    // Medida e Embalagem
    const m1 = await post('/measure/sincronize', { description: `METRO SMOKE ${stamp}`, abbreviation: 'MT', escale: 1 })
    check('measure cria', m1.status === 200 && m1.body.id > 0)
    const p1 = await post('/package/sincronize', { description: `CAIXA SMOKE ${stamp}`, abbreviation: 'CX' })
    check('package cria', p1.status === 200 && p1.body.id > 0)

    // Categoria: raiz → filho → pai inexistente 409 → mover subárvore
    const c1 = await post('/category/sincronize', { id: 900, description: 'RAIZ SMOKE', kind: 'P' })
    check('category raiz', c1.status === 200)
    const c2 = await post('/category/sincronize', { id: 901, description: 'FILHO SMOKE', kind: 'P', parentId: 900 })
    check('category filho', c2.status === 200)
    const c3 = await post('/category/sincronize', { id: 902, description: 'NETO SMOKE', kind: 'P', parentId: 901 })
    check('category neto', c3.status === 200)
    const c4 = await post('/category/sincronize', { id: 903, description: 'ORFAO', kind: 'P', parentId: 77777 })
    check('category pai inexistente → 409', c4.status === 409 && c4.body.code === 'PARENT_NOT_SYNCED')
    const c5 = await post('/category/sincronize', { id: 904, description: 'RAIZ2 SMOKE', kind: 'P' })
    const c6 = await post('/category/sincronize', { id: 901, description: 'FILHO MOVIDO', kind: 'P', parentId: 904 })
    check('category move', c5.status === 200 && c6.status === 200)
    const [[neto]] = await pool.query<any[]>(
      `SELECT posit_level FROM setes_setes.tb_category WHERE id = 902 AND tb_institution_id = 1`) as any
    check('subárvore acompanhou o pai', neto?.posit_level === '904.901.902', neto?.posit_level)

    // Limpeza
    await pool.query(`DELETE FROM setes_setes.tb_category WHERE id BETWEEN 900 AND 904 AND tb_institution_id = 1`)
    await pool.query(`DELETE FROM setes_setes.tb_institution_has_brand WHERE tb_brand_id = ?`, [b1.body.id])
    await pool.query(`DELETE FROM setes_setes.tb_institution_has_measure WHERE tb_measure_id = ?`, [m1.body.id])
    await pool.query(`DELETE FROM setes_setes.tb_institution_has_package WHERE tb_package_id = ?`, [p1.body.id])
    await pool.query(`DELETE FROM setes_central.tb_brand WHERE id = ?`, [b1.body.id])
    await pool.query(`DELETE FROM setes_central.tb_measure WHERE id = ?`, [m1.body.id])
    await pool.query(`DELETE FROM setes_central.tb_package WHERE id = ?`, [p1.body.id])
  } catch (e: any) {
    results.push('SMOKE ERRO: ' + e.message)
    process.exitCode = 1
  } finally {
    console.log(results.join('\n'))
    srv.close()
    await pool.end()
    process.exit(process.exitCode ?? 0)
  }
})
