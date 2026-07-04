import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { saveFiscalEntity } from './customer'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/salesman/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { tb_institution_id, Colaborador, Vendedor, Fiscal } = req.body
    const institutionId: number = tb_institution_id

    const tbEntityId = await saveFiscalEntity(conn, institutionId, Fiscal, Colaborador?.id)

    // tb_collaborator
    const [exCollab] = await conn.query<any[]>(
      `SELECT id FROM tb_collaborator WHERE id=? AND tb_institution_id=? LIMIT 1`,
      [tbEntityId, institutionId]
    )
    if (exCollab.length === 0) {
      await conn.query(
        `INSERT INTO tb_collaborator (id, tb_institution_id, active, created_at, updated_at) VALUES (?,?,?,NOW(),NOW())`,
        [tbEntityId, institutionId, Colaborador?.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_collaborator SET active=?, updated_at=NOW() WHERE id=? AND tb_institution_id=?`,
        [Colaborador?.active ?? 'S', tbEntityId, institutionId]
      )
    }

    // tb_salesman
    const [exSales] = await conn.query<any[]>(
      `SELECT id FROM tb_salesman WHERE id=? AND tb_institution_id=? LIMIT 1`,
      [tbEntityId, institutionId]
    )
    if (exSales.length === 0) {
      await conn.query(
        `INSERT INTO tb_salesman (id, tb_institution_id, commission, active, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW())`,
        [tbEntityId, institutionId, Vendedor?.commission ?? 0, Vendedor?.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_salesman SET commission=?, active=?, updated_at=NOW() WHERE id=? AND tb_institution_id=?`,
        [Vendedor?.commission ?? 0, Vendedor?.active ?? 'S', tbEntityId, institutionId]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /salesman/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
