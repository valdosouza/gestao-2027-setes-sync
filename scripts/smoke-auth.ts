// Smoke da Onda 1 — auth por tb_sync_api_key (D12) + envelope (D14)
import app from '../src/app'
import http from 'http'
import fs from 'fs'

const key = fs.readFileSync('.dev-sync-key', 'utf8').trim()

function post(path: string, apiKey?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: 'localhost',
        port: 3799,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
      },
      res => {
        let b = ''
        res.on('data', d => (b += d))
        res.on('end', () => resolve({ status: res.statusCode!, body: b }))
      }
    )
    req.on('error', reject)
    req.end('{}')
  })
}

const srv = app.listen(3799, async () => {
  try {
    const semChave    = await post('/promotion/sincronize')
    const chaveErrada = await post('/promotion/sincronize', 'nao_existe')
    const chaveCerta  = await post('/promotion/sincronize', key)
    console.log('sem chave    →', semChave.status, semChave.body)
    console.log('chave errada →', chaveErrada.status, chaveErrada.body)
    console.log('chave certa  →', chaveCerta.status, chaveCerta.body.slice(0, 300))
  } catch (e: any) {
    console.error('SMOKE ERRO:', e.message)
  } finally {
    srv.close()
    process.exit(0)
  }
})
