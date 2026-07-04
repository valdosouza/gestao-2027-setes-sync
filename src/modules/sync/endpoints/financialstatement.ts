import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import { findPaymentTypeByDescription } from '../sync.lookup'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/financialStatement/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id
    let recordId: number = b.id

    const payTypeId = await findPaymentTypeByDescription(conn, b.DescFormaPagamento, institutionId)

    if (!recordId || recordId === 0) {
      recordId = await nextId(conn, 'tb_financial_statement', institutionId)
    }

    const [ex] = await conn.query<any[]>(
      `SELECT id FROM tb_financial_statement WHERE id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
      [recordId, institutionId, b.terminal]
    )

    // normaliza todos os campos datetime
    const dtRecord = normalizeDate(b.dt_record)
    const dtExp    = normalizeDate(b.dt_expiration)
    const dtPay    = normalizeDate(b.dt_payment)

    if (ex.length === 0) {
      await conn.query(
        `INSERT INTO tb_financial_statement
           (id, tb_institution_id, terminal, tb_payment_types_id, tag_value, kind,
            situation, operation, dt_record, dt_expiration, dt_payment, tb_financial_plans_id,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [recordId, institutionId, b.terminal, payTypeId, b.tag_value, b.kind,
         b.situation, b.operation, dtRecord, dtExp, dtPay, b.tb_financial_plans_id]
      )
    } else {
      await conn.query(
        `UPDATE tb_financial_statement SET tb_payment_types_id=?, tag_value=?, kind=?,
           situation=?, operation=?, dt_record=?, dt_expiration=?, dt_payment=?,
           tb_financial_plans_id=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND terminal=?`,
        [payTypeId, b.tag_value, b.kind, b.situation, b.operation, dtRecord, dtExp, dtPay,
         b.tb_financial_plans_id, recordId, institutionId, b.terminal]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /financialStatement/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
