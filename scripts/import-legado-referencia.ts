/**
 * Importa a REFERÊNCIA do legado (D:\Gestao2027\seed\*_firebird.sql) para a
 * setes_central (2026-07-27 — 1ª rodada real: referência central vazia).
 *
 * Mapeamentos (ids EXATAMENTE como o Sincronizador envia):
 *   TB_PAIS   → tb_country: id = PAI_CODBACEN, name = PAI_DESCRICAO
 *   TB_STATE  → tb_state:   id = UFE_CODIGO (IBGE), abbreviation, name,
 *               aliquota = UFE_ALIQ_INT_EST (bate com a linha PR=12 pré-existente)
 *   TB_CIDADE → tb_city:    id = CDD_CODIGO (id do legado), ibge = CDD_IBGE,
 *               name, tb_state_id = sigla→IBGE, aliq_iss = CDD_ISS_ALIQ ?? 0
 *   TB_CFOP   → tb_cfop:    id = NAT_CFOP (dedupe: preferência ATIVO='S'),
 *               description/concise/active/register/way/jurisdiction/note
 *
 * Upsert (ON DUPLICATE KEY UPDATE): enriquece placeholders auto-criados pela
 * carga sem duplicar nada. Gera também o canônico
 * D:\Gestao2027\sql\07_seed_referencia_legado.sql.
 *
 * USO: npx tsx --require tsconfig-paths/register scripts/import-legado-referencia.ts
 */
import fs from 'fs'
import path from 'path'
import pool from '@shared/db/connection'

const SEED_DIR = 'D:/Gestao2027/seed'
const OUT_SQL  = 'D:/Gestao2027/sql/07_seed_referencia_legado.sql'

type Val = string | number | null

/** Extrai todas as tuplas VALUES (...) de um script de INSERTs do Firebird. */
function parseInserts(file: string): Val[][] {
  const raw = fs.readFileSync(path.join(SEED_DIR, file), 'latin1')
  const rows: Val[][] = []
  let i = 0
  while (true) {
    const v = raw.indexOf('VALUES', i)
    if (v < 0) break
    let j = raw.indexOf('(', v)
    if (j < 0) break
    // varre o grupo balanceado ciente de aspas ('' = escape)
    let depth = 0, inStr = false, tok = '', vals: Val[] = []
    const pushTok = () => {
      const t = tok.trim()
      tok = ''
      if (t === '') return
      if (/^null$/i.test(t)) vals.push(null)
      else if (/^-?\d+(\.\d+)?$/.test(t)) vals.push(Number(t))
      else if (t.startsWith("'")) vals.push(t.slice(1, -1).replace(/''/g, "'"))
      else vals.push(t)
    }
    for (; j < raw.length; j++) {
      const ch = raw[j]
      if (inStr) {
        if (ch === "'" && raw[j + 1] === "'") { tok += "''"; j++ }
        else if (ch === "'") { tok += ch; inStr = false }
        else tok += ch
        continue
      }
      if (ch === "'") { inStr = true; tok += ch }
      else if (ch === '(') { depth++; if (depth > 1) tok += ch }
      else if (ch === ')') { depth--; if (depth === 0) { pushTok(); break } tok += ch }
      else if (ch === ',' && depth === 1) pushTok()
      else tok += ch
    }
    if (vals.length) rows.push(vals)
    i = j + 1
  }
  return rows
}

const esc = (v: Val) => v === null ? 'NULL'
  : typeof v === 'number' ? String(v)
  : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`

function batchedSql(table: string, cols: string[], rows: Val[][], updateCols: string[]): string[] {
  const stmts: string[] = []
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400)
    const values = chunk.map(r => `(${r.map(esc).join(', ')})`).join(',\n  ')
    const upd = updateCols.map(c => `${c} = VALUES(${c})`).join(', ')
    stmts.push(`INSERT INTO setes_central.${table} (${cols.join(', ')})\nVALUES\n  ${values}\nON DUPLICATE KEY UPDATE ${upd}, updated_at = NOW();`)
  }
  return stmts
}

async function main() {
  // ---- parse ----
  const paises  = parseInserts('tb_pais_firebird.sql')     // PAI_CODIGO, PAI_CODBACEN, PAI_DESCRICAO
  const ufs     = parseInserts('tb_state_firebird.sql')    // UFE_CODIGO, UFE_SIGLA, UFE_ALIQ_INTERNA, UFE_DESCRICAO, UFE_MR_VL_AGREGADO, UFE_CEP, UFE_NUMINSC_SUBS, UFE_ALIQ_INT_EST, UFE_TX_FCP
  const cidades = parseInserts('tb_cidade_firebird.sql')   // CDD_CODIGO, CDD_IBGE, CDD_DESCRICAO, CDD_UF, CDD_CEP, CDD_ISS_ALIQ
  const cfops   = parseInserts('tb_cfop_firebird.sql')     // NAT_CODIGO, NAT_CFOP, NAT_DESCRICAO, NAT_RESUMIDO, NAT_ATIVO, NAT_REGISTRO, NAT_SENTIDO, NAT_ALCADA, NAT_APLICACAO, NAT_INTERNO
  console.log(`parse: ${paises.length} países, ${ufs.length} UFs, ${cidades.length} cidades, ${cfops.length} naturezas`)

  // ---- países (dedupe por BACEN — nomes múltiplos p/ mesmo código: 1º vence) ----
  const seenBacen = new Set<number>()
  const countryRows: Val[][] = []
  for (const p of paises) {
    const bacen = Number(p[1])
    if (!bacen || seenBacen.has(bacen)) continue
    seenBacen.add(bacen)
    countryRows.push([bacen, p[2]])
  }

  // ---- estados ----
  const ufToId = new Map<string, number>()
  const stateRows: Val[][] = []
  for (const u of ufs) {
    ufToId.set(String(u[1]), Number(u[0]))
    stateRows.push([Number(u[0]), 1058, u[1], u[3], u[7] ?? null])
  }

  // ---- cidades ----
  const cityRows: Val[][] = []
  let semUf = 0
  for (const c of cidades) {
    const stateId = ufToId.get(String(c[3]))
    if (!stateId) { semUf++; continue }
    cityRows.push([Number(c[0]), stateId, c[1] === null ? null : String(c[1]), c[2], Number(c[5] ?? 0)])
  }
  if (semUf) console.log(`⚠️ ${semUf} cidades com UF desconhecida — puladas`)

  // ---- CFOPs (dedupe por código; preferência p/ NAT_ATIVO='S') ----
  const byCfop = new Map<string, Val[]>()
  for (const n of cfops) {
    const code = String(n[1]).trim()
    if (!code) continue
    const cur = byCfop.get(code)
    if (!cur || (String(n[4]) === 'S' && String(cur[4]) !== 'S')) byCfop.set(code, n)
  }
  const cfopRows: Val[][] = []
  for (const [code, n] of byCfop) {
    cfopRows.push([code, n[2], n[3], n[4] ?? null, n[5] ?? null, n[6] ?? null, n[7] ?? null, n[8] ?? null])
  }

  // ---- SQL canônico ----
  const header = `-- =============================================================
-- 07_seed_referencia_legado.sql — Referência importada do legado
-- (D:\\Gestao2027\\seed\\*_firebird.sql; gerado por
-- setes-sync/scripts/import-legado-referencia.ts em 2026-07-27).
-- Ids EXATAMENTE como o Sincronizador envia: país BACEN, UF IBGE,
-- cidade id do legado (+ IBGE preenchido p/ Rodada 4), CFOP pelo código.
-- Idempotente: upsert — enriquece placeholders sem duplicar.
-- =============================================================\n`
  const stmts = [
    ...batchedSql('tb_country', ['id', 'name'], countryRows, ['name']),
    ...batchedSql('tb_state', ['id', 'tb_country_id', 'abbreviation', 'name', 'aliquota'],
      stateRows, ['tb_country_id', 'abbreviation', 'name', 'aliquota']),
    ...batchedSql('tb_city', ['id', 'tb_state_id', 'ibge', 'name', 'aliq_iss'],
      cityRows, ['tb_state_id', 'ibge', 'name', 'aliq_iss']),
    ...batchedSql('tb_cfop', ['id', 'description', 'concise', 'active', 'register', 'way', 'jurisdiction', 'note'],
      cfopRows, ['description', 'concise', 'active', 'register', 'way', 'jurisdiction', 'note']),
  ]
  const withDates = stmts.map(s => s.replace(/\)\nON DUPLICATE/g, ')\nON DUPLICATE'))
  fs.writeFileSync(OUT_SQL,
    header + '\n' + withDates.join('\n\n') + '\n', 'utf8')
  console.log(`canônico gerado: ${OUT_SQL} (${stmts.length} statements)`)

  // ---- aplica na base dev ----
  const conn = await pool.getConnection()
  try {
    for (const s of stmts) await conn.query(s)
    const counts: Record<string, number> = {}
    for (const t of ['tb_country', 'tb_state', 'tb_city', 'tb_cfop']) {
      const [[r]]: any = await conn.query(`SELECT COUNT(*) n FROM setes_central.${t}`)
      counts[t] = r.n
    }
    console.log('aplicado —', JSON.stringify(counts))
    const [[cur]]: any = await conn.query(
      `SELECT id, name, ibge FROM setes_central.tb_city WHERE ibge = '4106902' LIMIT 1`)
    console.log('spot-check Curitiba:', JSON.stringify(cur))
    const [ph]: any = await conn.query(
      `SELECT COUNT(*) n FROM setes_central.tb_city WHERE name LIKE '%(legado%'`)
    console.log('cidades placeholder restantes:', ph[0].n)
    const [[c59]]: any = await conn.query(
      `SELECT id, SUBSTRING(description,1,50) d FROM setes_central.tb_cfop WHERE id = '5900'`)
    console.log('spot-check CFOP 5900:', JSON.stringify(c59))
    const [dupIbge]: any = await conn.query(
      `SELECT ibge, COUNT(*) n FROM setes_central.tb_city WHERE ibge IS NOT NULL GROUP BY ibge HAVING n > 1 LIMIT 5`)
    console.log('ibge duplicado (conflito id legado × pré-existente):', JSON.stringify(dupIbge))
  } finally {
    conn.release()
    await pool.end()
  }
}

main().catch(e => { console.error('ERRO:', e.message); process.exit(1) })
