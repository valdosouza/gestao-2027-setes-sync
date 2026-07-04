import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/stocklist/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id
    let recordId: number = b.id

    if (!recordId || recordId === 0) recordId = await nextId(conn, 'tb_stock_list', institutionId)

    const [ex] = await conn.query<any[]>(
      `SELECT id FROM tb_stock_list WHERE id=? AND tb_institution_id=? LIMIT 1`,
      [recordId, institutionId]
    )
    if (ex.length === 0) {
      await conn.query(
        `INSERT INTO tb_stock_list (id, tb_institution_id, description, active, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())`,
        [recordId, institutionId, b.description, b.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_stock_list SET description=?, active=?, updated_at=NOW() WHERE id=? AND tb_institution_id=?`,
        [b.description, b.active ?? 'S', recordId, institutionId]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /stocklist/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
