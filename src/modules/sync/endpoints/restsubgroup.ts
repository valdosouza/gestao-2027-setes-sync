import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/restsubgroup/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id
    let recordId: number = b.id

    if (!recordId || recordId === 0) recordId = await nextId(conn, 'tb_rest_subgroup', institutionId)

    const [ex] = await conn.query<any[]>(
      `SELECT id FROM tb_rest_subgroup WHERE id=? AND tb_institution_id=? AND tb_rest_group_id=? LIMIT 1`,
      [recordId, institutionId, b.tb_rest_group_id]
    )
    if (ex.length === 0) {
      await conn.query(
        `INSERT INTO tb_rest_subgroup (id, tb_institution_id, tb_rest_group_id, description, active, created_at, updated_at)
         VALUES (?,?,?,?,?,NOW(),NOW())`,
        [recordId, institutionId, b.tb_rest_group_id, b.description, b.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_rest_subgroup SET description=?, active=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND tb_rest_group_id=?`,
        [b.description, b.active ?? 'S', recordId, institutionId, b.tb_rest_group_id]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /restsubgroup/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
