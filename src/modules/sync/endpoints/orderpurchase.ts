import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import { findPaymentTypeByDescription } from '../sync.lookup'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/orderpurchase/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { Pedido, PedidoCompra, Items, Totalizador, Cobranca, FormaPagamento, tb_institution_id } = req.body
    const institutionId: number = tb_institution_id

    const payTypeId = FormaPagamento ? await findPaymentTypeByDescription(conn, FormaPagamento, institutionId) : null

    let orderId: number = Pedido?.id ?? 0
    const [exOrd] = await conn.query<any[]>(
      `SELECT id FROM tb_order WHERE id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
      [orderId, institutionId, Pedido?.terminal]
    )
    if (exOrd.length === 0) {
      if (!orderId) orderId = await nextId(conn, 'tb_order', institutionId)
      await conn.query(
        `INSERT INTO tb_order (id, tb_institution_id, terminal, dt_record, situation, created_at, updated_at)
         VALUES (?,?,?,?,?,NOW(),NOW())`,
        [orderId, institutionId, Pedido?.terminal, normalizeDate(Pedido?.dt_record), Pedido?.situation]
      )
    } else {
      await conn.query(
        `UPDATE tb_order SET dt_record=?, situation=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND terminal=?`,
        [normalizeDate(Pedido?.dt_record), Pedido?.situation, orderId, institutionId, Pedido?.terminal]
      )
    }

    const [exPurch] = await conn.query<any[]>(
      `SELECT id FROM tb_order_purchase WHERE id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
      [orderId, institutionId, PedidoCompra?.terminal]
    )
    if (exPurch.length === 0) {
      await conn.query(
        `INSERT INTO tb_order_purchase (id, tb_institution_id, terminal, tb_payment_types_id, created_at, updated_at)
         VALUES (?,?,?,?,NOW(),NOW())`,
        [orderId, institutionId, PedidoCompra?.terminal, payTypeId]
      )
    } else {
      await conn.query(
        `UPDATE tb_order_purchase SET tb_payment_types_id=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND terminal=?`,
        [payTypeId, orderId, institutionId, PedidoCompra?.terminal]
      )
    }

    if (Array.isArray(Items)) {
      for (const item of Items) {
        const [exItem] = await conn.query<any[]>(
          `SELECT id FROM tb_order_item WHERE id=? AND tb_order_id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
          [item.id, orderId, institutionId, item.terminal]
        )
        if (exItem.length === 0) {
          const itemId = item.id || await nextId(conn, 'tb_order_item', institutionId)
          await conn.query(
            `INSERT INTO tb_order_item (id, tb_order_id, tb_institution_id, terminal, tb_merchandise_id, quantity, price, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
            [itemId, orderId, institutionId, item.terminal, item.tb_merchandise_id, item.quantity, item.price]
          )
        } else {
          await conn.query(
            `UPDATE tb_order_item SET quantity=?, price=?, updated_at=NOW()
             WHERE id=? AND tb_order_id=? AND tb_institution_id=? AND terminal=?`,
            [item.quantity, item.price, item.id, orderId, institutionId, item.terminal]
          )
        }
      }
    }

    if (Totalizador) {
      await conn.query(
        `INSERT INTO tb_order_totalizer (tb_order_id, tb_institution_id, total_items, total_discount, total_value, created_at, updated_at)
         VALUES (?,?,?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE total_items=VALUES(total_items), total_discount=VALUES(total_discount), total_value=VALUES(total_value), updated_at=NOW()`,
        [orderId, institutionId, Totalizador.total_items, Totalizador.total_discount, Totalizador.total_value]
      )
    }

    if (Cobranca) {
      await conn.query(
        `INSERT INTO tb_order_billing (tb_order_id, tb_institution_id, value, created_at, updated_at)
         VALUES (?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE value=VALUES(value), updated_at=NOW()`,
        [orderId, institutionId, Cobranca.value]
      )
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /orderpurchase/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
