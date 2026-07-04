import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { saveFiscalEntity } from './customer'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/provider/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { tb_institution_id, Fornecedor, Fiscal } = req.body
    const institutionId: number = tb_institution_id

    const tbEntityId = await saveFiscalEntity(conn, institutionId, Fiscal, Fornecedor?.id)

    // tb_provider
    const [ex] = await conn.query<any[]>(
      `SELECT id FROM tb_provider WHERE id=? AND tb_institution_id=? LIMIT 1`,
      [tbEntityId, institutionId]
    )
    if (ex.length === 0) {
      await conn.query(
        `INSERT INTO tb_provider (id, tb_institution_id, active, created_at, updated_at)
         VALUES (?,?,?,NOW(),NOW())`,
        [tbEntityId, institutionId, Fornecedor?.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_provider SET active=?, updated_at=NOW() WHERE id=? AND tb_institution_id=?`,
        [Fornecedor?.active ?? 'S', tbEntityId, institutionId]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /provider/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
