import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/Promotion/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { tb_institution_id, Promocao, Itens } = req.body
    const institutionId: number = tb_institution_id
    let recordId: number = Promocao?.id ?? 0

    if (!recordId || recordId === 0) recordId = await nextId(conn, 'tb_promotion', institutionId)

    const [ex] = await conn.query<any[]>(
      `SELECT id FROM tb_promotion WHERE id=? AND tb_institution_id=? LIMIT 1`,
      [recordId, institutionId]
    )
    if (ex.length === 0) {
      await conn.query(
        `INSERT INTO tb_promotion (id, tb_institution_id, description, dt_begin, dt_end, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,NOW(),NOW())`,
        [recordId, institutionId, Promocao?.description,
         normalizeDate(Promocao?.dt_begin), normalizeDate(Promocao?.dt_end), Promocao?.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_promotion SET description=?, dt_begin=?, dt_end=?, active=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=?`,
        [Promocao?.description, normalizeDate(Promocao?.dt_begin), normalizeDate(Promocao?.dt_end),
         Promocao?.active ?? 'S', recordId, institutionId]
      )
    }

    if (Array.isArray(Itens)) {
      for (const item of Itens) {
        await conn.query(
          `INSERT INTO tb_promotion_items (tb_promotion_id, tb_institution_id, tb_product_id, discount, created_at, updated_at)
           VALUES (?,?,?,?,NOW(),NOW())
           ON DUPLICATE KEY UPDATE discount=VALUES(discount), updated_at=NOW()`,
          [recordId, institutionId, item.tb_product_id, item.discount]
        )
      }
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /Promotion/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
