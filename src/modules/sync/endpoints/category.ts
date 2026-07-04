import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/category/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const b = req.body
    const institutionId: number = b.tb_institution_id
    let recordId: number = b.id

    if (!recordId || recordId === 0) {
      recordId = await nextId(conn, 'tb_category', institutionId)
      await conn.query(
        `INSERT INTO tb_category (id, tb_institution_id, description, posit_level, kind, Active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [recordId, institutionId, b.description, b.posit_level, b.kind, b.Active ?? 'S']
      )
    } else {
      const [existing] = await conn.query<any[]>(
        `SELECT id FROM tb_category WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
        [recordId, institutionId]
      )
      if (existing.length) {
        await conn.query(
          `UPDATE tb_category SET description = ?, posit_level = ?, kind = ?, Active = ?, updated_at = NOW()
           WHERE id = ? AND tb_institution_id = ?`,
          [b.description, b.posit_level, b.kind, b.Active ?? 'S', recordId, institutionId]
        )
      } else {
        await conn.query(
          `INSERT INTO tb_category (id, tb_institution_id, description, posit_level, kind, Active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [recordId, institutionId, b.description, b.posit_level, b.kind, b.Active ?? 'S']
        )
      }
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /category/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
