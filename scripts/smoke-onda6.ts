// Smoke da Onda 6 — retornos NF-e 55/65, NFS-e e arquivo XML em disco
import app from '../src/app'
import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import pool from '../src/shared/db/connection'

const key = fs.readFileSync('.dev-sync-key', 'utf8').trim()
const PORT = 3793
const ROOT = path.join(os.tmpdir(), 'setes-sync-smoke-files')
process.env.SYNC_FILES_ROOT = ROOT

function post(p: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: 'localhost', port: PORT, path: p, method: 'POST',
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

const srv = app.listen(PORT, async () => {
  try {
    // Retorno 55
    const r55 = await post('/invoice-return-55/sincronize', {
      id: 9901, terminal: 0, number: '000123', serie: '1', statusCode: 100,
      fileName: 'teste-nfe.xml', motive: 'Autorizado o uso da NF-e' })
    check('retorno 55', r55.status === 200 && r55.body.id === 9901)

    // Retorno 65
    const r65 = await post('/invoice-return-65/sincronize', {
      id: 9902, terminal: 0, number: '000200', serie: '1', nrLot: 7,
      statusCode: 100, fileName: 'teste-nfce.xml' })
    check('retorno 65', r65.status === 200)

    // Retorno NFS-e (era o bug C3 — classe comentada no Delphi)
    const rsv = await post('/invoice-return-service/sincronize', {
      id: 9903, terminal: 0, number: '55', nrRps: 55, protocol: 'PROT-1',
      codeVerif: 'ABC123', statusCode: 200 })
    check('retorno NFS-e', rsv.status === 200, JSON.stringify(rsv.body))

    // Reenvio (upsert) não duplica
    const r55b = await post('/invoice-return-55/sincronize', {
      id: 9901, terminal: 0, number: '000123', statusCode: 135, motive: 'Cancelado' })
    const [[cnt]] = await pool.query<any[]>(
      `SELECT COUNT(*) n, MAX(status_code) sc FROM setes_setes.tb_invoice_return_55 WHERE id = 9901 AND tb_institution_id = 1`) as any
    check('reenvio 55 = upsert', r55b.status === 200 && Number(cnt.n) === 1 && Number(cnt.sc) === 135)

    // Arquivo XML: grava em disco por CNPJ/ano/mês
    const xml = Buffer.from('<?xml version="1.0"?><nfe>SMOKE</nfe>').toString('base64')
    const fx = await post('/filexml/sincronize', {
      fileName: 'smoke-nfe.xml', contentBase64: xml, dtReference: '2026-07-19' })
    check('filexml aceita', fx.status === 200, JSON.stringify(fx.body))
    const [[inst]] = await pool.query<any[]>(
      `SELECT COALESCE((SELECT cnpj FROM setes_central.tb_company WHERE id = 1 AND deleted = 'N'), 'SETES-DEV') c`) as any
    const expected = path.join(ROOT, String(inst.c), '2026', '07', 'smoke-nfe.xml')
    check('arquivo no caminho <cnpj>/<ano>/<mes>', fs.existsSync(expected), expected)
    if (fs.existsSync(expected)) {
      check('conteúdo decodificado do Base64', fs.readFileSync(expected, 'utf8').includes('SMOKE'))
    }

    // Path traversal bloqueado
    const evil = await post('/filexml/sincronize', {
      fileName: '../../evil.xml', contentBase64: xml, dtReference: '2026-07-19' })
    check('path traversal → 400', evil.status === 400)
  } catch (e: any) {
    results.push('SMOKE ERRO: ' + e.message)
    process.exitCode = 1
  } finally {
    try {
      await pool.query(`DELETE FROM setes_setes.tb_invoice_return_55 WHERE id = 9901 AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_invoice_return_65 WHERE id = 9902 AND tb_institution_id = 1`)
      await pool.query(`DELETE FROM setes_setes.tb_invoice_return_service WHERE id = 9903 AND tb_institution_id = 1`)
      fs.rmSync(ROOT, { recursive: true, force: true })
    } catch (e: any) { results.push('LIMPEZA ERRO: ' + e.message) }
    console.log(results.join('\n'))
    srv.close()
    await pool.end()
    process.exit(process.exitCode ?? 0)
  }
})
