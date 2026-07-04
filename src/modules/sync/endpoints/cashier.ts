import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/cashier/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id
    const dtRecord = normalizeDate(b.dt_record)
    const hrBegin  = normalizeDate(b.hr_begin)
    const hrEnd    = normalizeDate(b.hr_end)

    const [existing] = await conn.query<any[]>(
      `SELECT id FROM tb_Cashier WHERE tb_institution_id = ? AND terminal = ? AND dt_record = ? LIMIT 1`,
      [institutionId, b.terminal, dtRecord]
    )

    let cashierId: number
    if (existing.length === 0) {
      cashierId = await nextId(conn, 'tb_Cashier', institutionId)
      await conn.query(
        `INSERT INTO tb_Cashier (id, tb_institution_id, terminal, dt_record, tb_userid, hr_begin, hr_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [cashierId, institutionId, b.terminal, dtRecord, b.tb_userid, hrBegin, hrEnd]
      )
    } else {
      cashierId = existing[0].id
      await conn.query(
        `UPDATE tb_Cashier SET tb_userid = ?, hr_begin = ?, hr_end = ?, updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [b.tb_userid, hrBegin, hrEnd, cashierId, institutionId]
      )
    }

    if (Array.isArray(b.items)) {
      for (const item of b.items) {
        const [ei] = await conn.query<any[]>(
          `SELECT id FROM tb_cashier_items WHERE tb_cashier_id = ? AND tb_payment_types_id = ? AND kind = ? LIMIT 1`,
          [cashierId, item.tb_payment_types_id, item.kind]
        )
        if (ei.length === 0) {
          const itemId = await nextId(conn, 'tb_cashier_items', institutionId)
          await conn.query(
            `INSERT INTO tb_cashier_items (id, tb_institution_id, tb_cashier_id, tb_payment_types_id, kind, tag_value, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [itemId, institutionId, cashierId, item.tb_payment_types_id, item.kind, item.tag_value]
          )
        } else {
          await conn.query(
            `UPDATE tb_cashier_items SET tag_value = ?, updated_at = NOW()
             WHERE id = ? AND tb_institution_id = ?`,
            [item.tag_value, ei[0].id, institutionId]
          )
        }
      }
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /cashier/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
