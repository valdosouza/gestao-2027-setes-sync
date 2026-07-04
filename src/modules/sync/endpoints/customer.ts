import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextGlobalId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import logger from '@shared/logger/logger'

const router = Router()

async function saveFiscalEntity(conn: any, institutionId: number, Fiscal: any, entityId?: number): Promise<number> {
  const Entidade  = Fiscal.Entidade.Registro
  const Email     = Fiscal.Entidade.Email
  const Enderecos = Fiscal.Entidade.ListaEndereco || []
  const Fones     = Fiscal.Entidade.ListaFones    || []

  let tbEntityId = entityId && entityId > 0 ? entityId : 0

  if (tbEntityId > 0) {
    const res1   = await conn.query('SELECT id FROM tb_entity WHERE id = ? LIMIT 1', [tbEntityId])
    const existe = res1[0] as any[]
    if (existe.length) {
      await conn.query(
        'UPDATE tb_entity SET name_company=?, nick_trade=?, aniversary=?, tb_line_business_id=?, note=?, updated_at=NOW() WHERE id=?',
        [Entidade.name_company, Entidade.nick_trade, normalizeDate(Entidade.aniversary), Entidade.tb_line_business_id, Entidade.note, tbEntityId]
      )
    } else {
      await conn.query(
        'INSERT INTO tb_entity (id, name_company, nick_trade, aniversary, tb_line_business_id, note, created_at, updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW())',
        [tbEntityId, Entidade.name_company, Entidade.nick_trade, normalizeDate(Entidade.aniversary), Entidade.tb_line_business_id, Entidade.note]
      )
    }
  } else {
    tbEntityId = await nextGlobalId(conn, 'tb_entity')
    await conn.query(
      'INSERT INTO tb_entity (id, name_company, nick_trade, aniversary, tb_line_business_id, note, created_at, updated_at) VALUES (?,?,?,?,?,?,NOW(),NOW())',
      [tbEntityId, Entidade.name_company, Entidade.nick_trade, normalizeDate(Entidade.aniversary), Entidade.tb_line_business_id, Entidade.note]
    )
  }

  if (Fiscal.Fisica && Fiscal.Fisica.cpf) {
    await conn.query(
      'INSERT INTO tb_person (id, cpf, rg, birthday, tb_profession_id, created_at, updated_at) VALUES (?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE cpf=VALUES(cpf), rg=VALUES(rg), birthday=VALUES(birthday), updated_at=NOW()',
      [tbEntityId, Fiscal.Fisica.cpf, Fiscal.Fisica.rg, normalizeDate(Fiscal.Fisica.birthday), Fiscal.Fisica.tb_profession_id]
    )
  } else if (Fiscal.Juridica && Fiscal.Juridica.cnpj) {
    await conn.query(
      'INSERT INTO tb_company (id, cnpj, ie, im, crt, created_at, updated_at) VALUES (?,?,?,?,?,NOW(),NOW()) ON DUPLICATE KEY UPDATE cnpj=VALUES(cnpj), ie=VALUES(ie), im=VALUES(im), crt=VALUES(crt), updated_at=NOW()',
      [tbEntityId, Fiscal.Juridica.cnpj, Fiscal.Juridica.ie, Fiscal.Juridica.im, Fiscal.Juridica.crt]
    )
  }

  for (const end of Enderecos) {
    await conn.query(
      'INSERT IGNORE INTO tb_address (tb_entity_id, kind, street, nmbr, complement, neighborhood, region, zip_code, tb_country_id, tb_state_id, tb_city_id, main, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())',
      [tbEntityId, end.kind, end.street, end.nmbr, end.complement, end.neighborhood, end.region, end.zip_code, end.tb_country_id, end.tb_state_id, end.tb_city_id, end.main]
    )
  }

  for (const fone of Fones) {
    await conn.query(
      'INSERT IGNORE INTO tb_phone (tb_entity_id, kind, contact, number, address_kind, created_at, updated_at) VALUES (?,?,?,?,?,NOW(),NOW())',
      [tbEntityId, fone.kind, fone.contact, fone.number, fone.address_kind]
    )
  }

  if (Email && Email.email) {
    await conn.query(
      'INSERT IGNORE INTO tb_mailing (tb_entity_id, email, created_at, updated_at) VALUES (?,?,NOW(),NOW())',
      [tbEntityId, Email.email]
    )
  }

  return tbEntityId
}

router.post('/Customer/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('USE `' + req.syncClient!.schemaName + '`')

    const { tb_institution_id, Cliente, Fiscal, DocFiscalVendedor } = req.body
    const institutionId: number = tb_institution_id

    const tbEntityId = await saveFiscalEntity(conn, institutionId, Fiscal, Cliente.id)

    await conn.query(
      'INSERT IGNORE INTO tb_institution_has_entity (tb_institution_id, tb_entity_id) VALUES (?,?)',
      [institutionId, tbEntityId]
    )

    let salesmanEntityId: number | null = null
    if (DocFiscalVendedor) {
      const digits = DocFiscalVendedor.replace(/\D/g, '')
      if (digits.length === 11) {
        const r1 = await conn.query('SELECT tb_entity_id FROM tb_person WHERE cpf = ? LIMIT 1', [digits])
        const rr = r1[0] as any[]
        salesmanEntityId = rr.length ? rr[0].tb_entity_id : null
      } else if (digits.length === 14) {
        const r1 = await conn.query('SELECT tb_entity_id FROM tb_company WHERE cnpj = ? LIMIT 1', [digits])
        const rr = r1[0] as any[]
        salesmanEntityId = rr.length ? rr[0].tb_entity_id : null
      }
    }

    const r2     = await conn.query('SELECT id FROM tb_customer WHERE id = ? AND tb_institution_id = ? LIMIT 1', [tbEntityId, institutionId])
    const exCust = r2[0] as any[]

    if (exCust.length) {
      await conn.query(
        'UPDATE tb_customer SET tb_salesman_id=?, tb_carrier_id=?, credit_status=?, credit_value=?, wallet=?, consumer=?, active=?, multiplier=?, by_pass_st=?, updated_at=NOW() WHERE id=? AND tb_institution_id=?',
        [salesmanEntityId !== null ? salesmanEntityId : Cliente.tb_salesman_id, Cliente.tb_carrier_id, Cliente.credit_status, Cliente.credit_value, Cliente.wallet, Cliente.consumer, Cliente.active, Cliente.multiplier, Cliente.by_pass_st, tbEntityId, institutionId]
      )
    } else {
      await conn.query(
        'INSERT INTO tb_customer (id, tb_institution_id, tb_salesman_id, tb_carrier_id, credit_status, credit_value, wallet, consumer, active, multiplier, by_pass_st, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())',
        [tbEntityId, institutionId, salesmanEntityId !== null ? salesmanEntityId : Cliente.tb_salesman_id, Cliente.tb_carrier_id, Cliente.credit_status, Cliente.credit_value, Cliente.wallet, Cliente.consumer, Cliente.active, Cliente.multiplier, Cliente.by_pass_st]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /Customer/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export { saveFiscalEntity }
export default router
