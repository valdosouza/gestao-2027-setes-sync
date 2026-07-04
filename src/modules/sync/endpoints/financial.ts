import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import { findPaymentTypeByDescription } from '../sync.lookup'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/financial/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { Financeiro, Pagamentos, DescFormaPagamento } = req.body
    const institutionId: number = Financeiro.tb_institution_id

    const payTypeId = await findPaymentTypeByDescription(conn, DescFormaPagamento, institutionId)

    const [ex] = await conn.query<any[]>(
      `SELECT id FROM tb_financial WHERE id=? AND tb_order_id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
      [Financeiro.id, Financeiro.tb_order_id, institutionId, Financeiro.terminal]
    )

    let finId = Financeiro.id
    const dtExp = normalizeDate(Financeiro.dt_expiration)

    if (ex.length === 0) {
      if (!finId || finId === 0) finId = await nextId(conn, 'tb_financial', institutionId)
      await conn.query(
        `INSERT INTO tb_financial
           (id, tb_order_id, tb_institution_id, terminal, parcel, tag_value, dt_expiration,
            tb_payment_types_id, number, kind, situation, operation, stage, tb_financial_plans_id,
            created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [finId, Financeiro.tb_order_id, institutionId, Financeiro.terminal, Financeiro.parcel,
         Financeiro.tag_value, dtExp, payTypeId, Financeiro.number, Financeiro.kind,
         Financeiro.situation, Financeiro.operation, Financeiro.stage, Financeiro.tb_financial_plans_id]
      )
    } else {
      await conn.query(
        `UPDATE tb_financial SET parcel=?, tag_value=?, dt_expiration=?, tb_payment_types_id=?,
           number=?, kind=?, situation=?, operation=?, stage=?, tb_financial_plans_id=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND terminal=?`,
        [Financeiro.parcel, Financeiro.tag_value, dtExp, payTypeId, Financeiro.number, Financeiro.kind,
         Financeiro.situation, Financeiro.operation, Financeiro.stage, Financeiro.tb_financial_plans_id,
         finId, institutionId, Financeiro.terminal]
      )
    }

    if (Pagamentos) {
      const P = Pagamentos
      const dtPay     = normalizeDate(P.dt_payment)
      const dtRealPay = normalizeDate(P.dt_real_payment)

      const [exP] = await conn.query<any[]>(
        `SELECT id FROM tb_financial_payment WHERE tb_financial_id=? AND tb_institution_id=? LIMIT 1`,
        [finId, institutionId]
      )
      if (exP.length === 0) {
        await conn.query(
          `INSERT INTO tb_financial_payment
             (tb_financial_id, tb_institution_id, interest_value, late_value, discount_value,
              discount_aliquot, paid_value, tb_payment_types_id, dt_payment, dt_real_payment,
              settled, tb_financial_plans_id, settled_code, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
          [finId, institutionId, P.interest_value, P.late_value, P.discount_value,
           P.discount_aliquot, P.paid_value, P.tb_payment_types_id, dtPay, dtRealPay,
           P.settled, P.tb_financial_plans_id, P.settled_code]
        )
      } else {
        await conn.query(
          `UPDATE tb_financial_payment SET interest_value=?, late_value=?, discount_value=?,
             discount_aliquot=?, paid_value=?, tb_payment_types_id=?, dt_payment=?,
             dt_real_payment=?, settled=?, tb_financial_plans_id=?, settled_code=?, updated_at=NOW()
           WHERE tb_financial_id=? AND tb_institution_id=?`,
          [P.interest_value, P.late_value, P.discount_value, P.discount_aliquot, P.paid_value,
           P.tb_payment_types_id, dtPay, dtRealPay, P.settled, P.tb_financial_plans_id,
           P.settled_code, finId, institutionId]
        )
      }
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /financial/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
