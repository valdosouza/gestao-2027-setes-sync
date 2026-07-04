import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/stockbalance/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id

    await conn.query(
      `INSERT INTO tb_stock_balance
         (tb_institution_id, tb_stock_list_id, tb_merchandise_id, quantity, created_at, updated_at)
       VALUES (?,?,?,?,NOW(),NOW())
       ON DUPLICATE KEY UPDATE quantity=VALUES(quantity), updated_at=NOW()`,
      [institutionId, b.tb_stock_list_id, b.tb_merchandise_id, b.quantity]
    )

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /stockbalance/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
