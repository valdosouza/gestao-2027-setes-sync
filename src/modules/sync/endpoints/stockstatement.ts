import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import logger from '@shared/logger/logger'

const router = Router()

// ATENÇÃO: O trigger MySQL `after_stock_statement_insert` atualiza tb_stock_balance automaticamente.
// Não replicar essa lógica aqui.

router.post('/stockstatement/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id
    let recordId: number = b.id

    if (!recordId || recordId === 0) recordId = await nextId(conn, 'tb_stock_statement', institutionId)

    const dtRecord = normalizeDate(b.dt_record)

    const [ex] = await conn.query<any[]>(
      `SELECT id FROM tb_stock_statement WHERE id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
      [recordId, institutionId, b.terminal]
    )
    if (ex.length === 0) {
      await conn.query(
        `INSERT INTO tb_stock_statement
           (id, tb_institution_id, terminal, tb_stock_list_id, tb_merchandise_id,
            direction, quantity, dt_record, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [recordId, institutionId, b.terminal, b.tb_stock_list_id, b.tb_merchandise_id,
         b.direction, b.quantity, dtRecord]
      )
    } else {
      await conn.query(
        `UPDATE tb_stock_statement SET direction=?, quantity=?, dt_record=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND terminal=?`,
        [b.direction, b.quantity, dtRecord, recordId, institutionId, b.terminal]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /stockstatement/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
