import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import { findBankByNumber } from '../sync.lookup'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/bankaccount/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id

    const tbBankId = await findBankByNumber(conn, b.NumeroBanco)

    const [existing] = await conn.query<any[]>(
      `SELECT id FROM tb_bank_account WHERE tb_bank_id = ? AND agency = ? AND number = ? LIMIT 1`,
      [tbBankId, b.agency, b.number]
    )

    const dtOpening  = normalizeDate(b.dt_opening)
    const dtContract = normalizeDate(b.dt_contract)

    if (existing.length === 0) {
      const newId = await nextId(conn, 'tb_bank_account', institutionId)
      await conn.query(
        `INSERT INTO tb_bank_account
           (id, tb_institution_id, tb_bank_id, agency, agency_dv, number, number_dv,
            phone, manager, limit_value, dt_opening, dt_contract, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [newId, institutionId, tbBankId, b.agency, b.agency_dv, b.number, b.number_dv,
         b.phone, b.manager, b.limit_value, dtOpening, dtContract]
      )
      await conn.query(
        `INSERT IGNORE INTO tb_institution_has_bank (tb_institution_id, tb_bank_account_id)
         VALUES (?, ?)`,
        [institutionId, newId]
      )
    } else {
      await conn.query(
        `UPDATE tb_bank_account SET
           tb_bank_id = ?, agency = ?, agency_dv = ?, number = ?, number_dv = ?,
           phone = ?, manager = ?, limit_value = ?, dt_opening = ?, dt_contract = ?,
           updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [tbBankId, b.agency, b.agency_dv, b.number, b.number_dv,
         b.phone, b.manager, b.limit_value, dtOpening, dtContract,
         existing[0].id, institutionId]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /bankaccount/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
