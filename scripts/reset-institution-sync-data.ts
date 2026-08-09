/**
 * Reset de dados sincronizados de um institution de TESTE (Valdo, 2026-08-09).
 *
 * Zera TODAS as tabelas de dados do schema do institution (customer, provider,
 * salesman, carrier, collaborator, product, merchandise, stock, price,
 * category, order*, invoice*, financial*, etc.) e limpa as entidades da
 * setes_central que só existem por causa desse institution (tb_entity,
 * tb_company, tb_person, tb_no_doc, tb_address, tb_phone,
 * tb_entity_has_mailing) — MANTENDO apenas a entidade do PRÓPRIO institution
 * (id = institutionId, o registro criado no cadastro do estabelecimento).
 *
 * NÃO toca em: tb_institution, tb_sync_api_key, tb_feature_flag, catálogos
 * centrais (module/interface/bank/country/state/city), _migrations.
 *
 * Uso: primeira carga de teste ficou "suja" (dados errados, decisão de
 * desenho mudou, etc.) e você quer recomeçar do zero sem recriar o
 * institution inteiro (chave de API, schema, migrations continuam válidos).
 *
 * ⚠️ DESTRUTIVO e IRREVERSÍVEL. Roda em modo DRY-RUN por padrão (só mostra o
 * que seria apagado). Passe --confirm para executar de verdade:
 *
 *   npx tsx --require tsconfig-paths/register scripts/reset-institution-sync-data.ts
 *   npx tsx --require tsconfig-paths/register scripts/reset-institution-sync-data.ts --confirm
 *
 * Para reusar em outro institution de teste, ajuste SCHEMA_NAME e
 * KEEP_ENTITY_ID abaixo (KEEP_ENTITY_ID = institutionId, pela herança de PK
 * tb_institution.id === tb_entity.id).
 */
import pool from '../src/shared/db/connection'

const SCHEMA_NAME = 'setes_pipoteca'
const KEEP_ENTITY_ID = 3 // = institutionId da Pipoteca

// Tabelas de dados do schema do institution — ajuste se o schema tiver
// tabelas novas (rode a query de descoberta no fim deste arquivo se precisar
// regenerar a lista).
const SCHEMA_TABLES = [
  'tb_bank_account', 'tb_carrier', 'tb_category', 'tb_collaborator', 'tb_customer',
  'tb_entity_tax', 'tb_financial', 'tb_financial_bills', 'tb_financial_payment',
  'tb_financial_plans', 'tb_financial_statement', 'tb_institution_has_brand',
  'tb_institution_has_measure', 'tb_institution_has_package', 'tb_institution_has_payment_types',
  'tb_invoice', 'tb_invoice_merchandise', 'tb_invoice_return_55', 'tb_merchandise',
  'tb_order', 'tb_order_billing', 'tb_order_item', 'tb_order_item_merchandise',
  'tb_order_purchase', 'tb_order_sale', 'tb_order_stock_adjust', 'tb_order_totalizer',
  'tb_price', 'tb_price_list', 'tb_product', 'tb_provider', 'tb_salesman', 'tb_stock',
  'tb_stock_balance', 'tb_stock_list',
]

// Tabelas da setes_central cuja PK é a entity id (herança direta) — deleta
// tudo MENOS KEEP_ENTITY_ID.
const CENTRAL_ENTITY_ID_TABLES = ['tb_address', 'tb_phone', 'tb_no_doc', 'tb_company', 'tb_person', 'tb_entity']

async function main() {
  const confirm = process.argv.includes('--confirm')
  const conn = await pool.getConnection()
  try {
    if (!confirm) {
      console.log('DRY-RUN (nada será apagado) — passe --confirm para executar de verdade.\n')
    }

    await conn.query(`USE \`${SCHEMA_NAME}\``)
    console.log(`--- schema ${SCHEMA_NAME} ---`)
    for (const t of SCHEMA_TABLES) {
      const [[row]]: any = await conn.query(`SELECT COUNT(*) c FROM \`${t}\``)
      console.log(t.padEnd(38), row.c)
    }

    await conn.query('USE `setes_central`')
    console.log(`\n--- setes_central (entidades fora de id=${KEEP_ENTITY_ID}) ---`)
    const [[mailingCount]]: any = await conn.query(
      `SELECT COUNT(*) c FROM tb_entity_has_mailing WHERE tb_entity_id <> ?`, [KEEP_ENTITY_ID])
    console.log('tb_entity_has_mailing'.padEnd(38), mailingCount.c)
    for (const t of CENTRAL_ENTITY_ID_TABLES) {
      const [[row]]: any = await conn.query(`SELECT COUNT(*) c FROM \`${t}\` WHERE id <> ?`, [KEEP_ENTITY_ID])
      console.log(t.padEnd(38), row.c)
    }

    if (!confirm) {
      console.log('\nDRY-RUN concluído. Rode de novo com --confirm para apagar.')
      return
    }

    console.log('\n--- apagando ---')
    await conn.query('SET FOREIGN_KEY_CHECKS=0')

    await conn.query(`USE \`${SCHEMA_NAME}\``)
    for (const t of SCHEMA_TABLES) {
      const [res]: any = await conn.query(`DELETE FROM \`${t}\``)
      console.log((SCHEMA_NAME + '.' + t).padEnd(45), 'deleted:', res.affectedRows)
    }

    await conn.query('USE `setes_central`')
    const [r0]: any = await conn.query(
      `DELETE FROM tb_entity_has_mailing WHERE tb_entity_id <> ?`, [KEEP_ENTITY_ID])
    console.log('central.tb_entity_has_mailing'.padEnd(45), 'deleted:', r0.affectedRows)
    for (const t of CENTRAL_ENTITY_ID_TABLES) {
      const [res]: any = await conn.query(`DELETE FROM \`${t}\` WHERE id <> ?`, [KEEP_ENTITY_ID])
      console.log(('central.' + t).padEnd(45), 'deleted:', res.affectedRows)
    }

    await conn.query('SET FOREIGN_KEY_CHECKS=1')

    console.log('\n--- verificação pós-delete ---')
    await conn.query(`USE \`${SCHEMA_NAME}\``)
    for (const t of SCHEMA_TABLES) {
      const [[row]]: any = await conn.query(`SELECT COUNT(*) c FROM \`${t}\``)
      console.log(t.padEnd(38), row.c)
    }
    await conn.query('USE `setes_central`')
    for (const t of CENTRAL_ENTITY_ID_TABLES) {
      const [[row]]: any = await conn.query(`SELECT COUNT(*) c FROM \`${t}\``)
      console.log(('central.' + t).padEnd(38), row.c)
    }
  } finally {
    conn.release()
  }
  process.exit(0)
}

main()

/* Query para regenerar SCHEMA_TABLES se o schema ganhar tabelas novas:
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'setes_pipoteca' AND TABLE_NAME NOT IN ('_migrations')
ORDER BY TABLE_NAME;
-- e filtrar só as que tiverem COUNT(*) > 0 antes de colar na lista acima. */
