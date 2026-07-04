import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextId } from '../sync.id-generator'
import { normalizeDate } from '../sync.date'
import { findPaymentTypeByDescription } from '../sync.lookup'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/ordersale/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { Pedido, PedidoVenda, Items, Totalizador, Cobranca, FormaPagamento, DocFiscalVendedor, tb_institution_id } = req.body
    const institutionId: number = tb_institution_id

    // Resolver vendedor
    let salesmanEntityId: number | null = null
    if (DocFiscalVendedor) {
      const digits = DocFiscalVendedor.replace(/\D/g, '')
      if (digits.length === 11) {
        const [r] = await conn.query<any[]>(`SELECT tb_entity_id FROM tb_person WHERE cpf=? LIMIT 1`, [digits])
        salesmanEntityId = r.length ? r[0].tb_entity_id : null
      } else if (digits.length === 14) {
        const [r] = await conn.query<any[]>(`SELECT tb_entity_id FROM tb_company WHERE cnpj=? LIMIT 1`, [digits])
        salesmanEntityId = r.length ? r[0].tb_entity_id : null
      }
    }

    // Forma de pagamento
    const payTypeId = FormaPagamento ? await findPaymentTypeByDescription(conn, FormaPagamento, institutionId) : null

    // tb_order
    let orderId: number = Pedido?.id ?? 0
    const [exOrd] = await conn.query<any[]>(
      `SELECT id FROM tb_order WHERE id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
      [orderId, institutionId, Pedido?.terminal]
    )
    if (exOrd.length === 0) {
      if (!orderId) orderId = await nextId(conn, 'tb_order', institutionId)
      await conn.query(
        `INSERT INTO tb_order (id, tb_institution_id, terminal, tb_salesman_id, dt_record, situation, created_at, updated_at)
         VALUES (?,?,?,?,?,?,NOW(),NOW())`,
        [orderId, institutionId, Pedido?.terminal, salesmanEntityId ?? Pedido?.tb_salesman_id,
         normalizeDate(Pedido?.dt_record), Pedido?.situation]
      )
    } else {
      await conn.query(
        `UPDATE tb_order SET tb_salesman_id=?, dt_record=?, situation=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND terminal=?`,
        [salesmanEntityId ?? Pedido?.tb_salesman_id, normalizeDate(Pedido?.dt_record),
         Pedido?.situation, orderId, institutionId, Pedido?.terminal]
      )
    }

    // tb_order_sale
    const [exSale] = await conn.query<any[]>(
      `SELECT id FROM tb_order_sale WHERE id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
      [orderId, institutionId, PedidoVenda?.terminal]
    )
    if (exSale.length === 0) {
      await conn.query(
        `INSERT INTO tb_order_sale (id, tb_institution_id, terminal, tb_payment_types_id, created_at, updated_at)
         VALUES (?,?,?,?,NOW(),NOW())`,
        [orderId, institutionId, PedidoVenda?.terminal, payTypeId]
      )
    } else {
      await conn.query(
        `UPDATE tb_order_sale SET tb_payment_types_id=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=? AND terminal=?`,
        [payTypeId, orderId, institutionId, PedidoVenda?.terminal]
      )
    }

    // itens
    if (Array.isArray(Items)) {
      for (const item of Items) {
        const [exItem] = await conn.query<any[]>(
          `SELECT id FROM tb_order_item WHERE id=? AND tb_order_id=? AND tb_institution_id=? AND terminal=? LIMIT 1`,
          [item.id, orderId, institutionId, item.terminal]
        )
        if (exItem.length === 0) {
          const itemId = item.id || await nextId(conn, 'tb_order_item', institutionId)
          await conn.query(
            `INSERT INTO tb_order_item
               (id, tb_order_id, tb_institution_id, terminal, tb_merchandise_id, quantity, price, created_at, updated_at)
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

    // tb_order_totalizer
    if (Totalizador) {
      await conn.query(
        `INSERT INTO tb_order_totalizer (tb_order_id, tb_institution_id, total_items, total_discount, total_value, created_at, updated_at)
         VALUES (?,?,?,?,?,NOW(),NOW())
         ON DUPLICATE KEY UPDATE total_items=VALUES(total_items), total_discount=VALUES(total_discount), total_value=VALUES(total_value), updated_at=NOW()`,
        [orderId, institutionId, Totalizador.total_items, Totalizador.total_discount, Totalizador.total_value]
      )
    }

    // tb_order_billing
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
    logger.error('Erro em /ordersale/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
