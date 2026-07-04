import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/restmenuhasingrediente/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id

    await conn.query(
      `INSERT INTO tb_rest_menu_has_ingredient
         (tb_institution_id, tb_rest_menu_id, tb_product_id, quantity, active, created_at, updated_at)
       VALUES (?,?,?,?,?,NOW(),NOW())
       ON DUPLICATE KEY UPDATE quantity=VALUES(quantity), active=VALUES(active), updated_at=NOW()`,
      [institutionId, b.tb_rest_menu_id, b.tb_product_id, b.quantity, b.active ?? 'S']
    )

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /restmenuhasingrediente/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
