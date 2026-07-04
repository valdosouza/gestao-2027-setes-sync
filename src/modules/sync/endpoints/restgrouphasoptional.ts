import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/restgrouphasoptional/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id

    await conn.query(
      `INSERT INTO tb_rest_group_has_optional
         (tb_institution_id, tb_rest_group_id, tb_product_id, active, created_at, updated_at)
       VALUES (?,?,?,?,NOW(),NOW())
       ON DUPLICATE KEY UPDATE active=VALUES(active), updated_at=NOW()`,
      [institutionId, b.tb_rest_group_id, b.tb_product_id, b.active ?? 'S']
    )

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /restgrouphasoptional/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
