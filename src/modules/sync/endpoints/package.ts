import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextGlobalId } from '../sync.id-generator'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/package/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { tb_institution_id, Embalagem } = req.body
    const institutionId: number = tb_institution_id
    let packageId: number

    if (Embalagem.id > 0) {
      const [ex] = await conn.query<any[]>(`SELECT id FROM tb_package WHERE id=? LIMIT 1`, [Embalagem.id])
      if (ex.length) {
        await conn.query(`UPDATE tb_package SET description=?, updated_at=NOW() WHERE id=?`, [Embalagem.description, Embalagem.id])
        packageId = Embalagem.id
      } else {
        await conn.query(`INSERT INTO tb_package (id, description, created_at, updated_at) VALUES (?,?,NOW(),NOW())`, [Embalagem.id, Embalagem.description])
        packageId = Embalagem.id
      }
    } else {
      const [rows] = await conn.query<any[]>(`SELECT id FROM tb_package WHERE description=? LIMIT 1`, [Embalagem.description])
      if (rows.length) {
        packageId = rows[0].id
      } else {
        packageId = await nextGlobalId(conn, 'tb_package')
        await conn.query(`INSERT INTO tb_package (id, description, created_at, updated_at) VALUES (?,?,NOW(),NOW())`, [packageId, Embalagem.description])
      }
    }

    await conn.query(
      `INSERT INTO tb_institution_has_package (tb_institution_id, tb_package_id) VALUES (?,?)
       ON DUPLICATE KEY UPDATE tb_package_id=tb_package_id`,
      [institutionId, packageId]
    )

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /package/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
