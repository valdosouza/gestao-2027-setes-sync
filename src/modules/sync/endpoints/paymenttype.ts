import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextGlobalId } from '../sync.id-generator'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/paymentType/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id
    let payTypeId: number = b.id

    const [ex] = await conn.query<any[]>(`SELECT id FROM tb_payment_types WHERE id=? LIMIT 1`, [payTypeId])
    if (ex.length === 0) {
      if (!payTypeId || payTypeId === 0) payTypeId = await nextGlobalId(conn, 'tb_payment_types')
      await conn.query(
        `INSERT INTO tb_payment_types (id, description, active, created_at, updated_at) VALUES (?,?,?,NOW(),NOW())`,
        [payTypeId, b.description, b.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_payment_types SET description=?, active=?, updated_at=NOW() WHERE id=?`,
        [b.description, b.active ?? 'S', payTypeId]
      )
    }

    await conn.query(
      `INSERT INTO tb_institution_has_payment_types (tb_institution_id, tb_payment_types_id, DisponivelApp)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE DisponivelApp=VALUES(DisponivelApp)`,
      [institutionId, payTypeId, b.DisponivelApp ?? 'N']
    )

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /paymentType/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
