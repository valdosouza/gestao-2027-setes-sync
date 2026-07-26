import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { PoolConnection } from 'mysql2/promise'
import { syncSuccess, syncError } from '../sync.response'
import { findEntityIdByDocument } from '../sync.entity'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Pedido de VENDA — 1º movimento da revisão (Onda 5). ID LOCAL ✅
 * (MAPA_INDEXACAO): PED_CODIGO É o id na web (tb_order, PK id+institution+
 * terminal — `terminal` é dimensão de TODAS as PKs do pedido e vem do
 * payload). Referências de entidade por DOCUMENTO (D3): customerDocument →
 * tb_customer e salesmanDocument → tb_salesman (papel PRECISA existir no
 * schema → 409 *_NOT_SYNCED, reenvio no próximo ciclo). Produto do item por
 * id local → 409 PRODUCT_NOT_SYNCED. `items` presente = SNAPSHOT (itens
 * fora da lista viram deleted='S'; kind fixo 'Sale' — padrão DP6). Forma de
 * pagamento da cobrança por DESCRIÇÃO (catálogo central + vínculo).
 * tb_order.tb_user_id é NOT NULL com FK na central: como o sync não tem
 * usuário local, usa o usuário mais antigo do institution
 * (tb_institution_has_user). Transação ÚNICA (pedido + satélites);
 * deleted='S' derruba tb_order e TODOS os satélites (D2).
 * Contrato: CONTRATOS_SYNC.md.
 */
const itemBody = z.object({
  id:              z.number().int().positive(),
  productId:       z.number().int().positive(),
  quantity:        z.number(),
  unitValue:       z.number(),
  discountAliquot: z.number().optional().nullable(),
  discountValue:   z.number().optional().nullable(),
  stockListId:     z.number().int().positive().optional().nullable(),
  priceListId:     z.number().int().positive().optional().nullable(),
})

const orderSaleBody = z.object({
  id:       z.number().int().positive(),
  terminal: z.number().int().min(0),
  deleted:  z.enum(['S', 'N']).optional().default('N'),
  order: z.object({
    dtRecord: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    note:     z.string().optional().nullable(),
    status:   z.string().max(1).optional().nullable(),
    origin:   z.string().max(1).optional().default('D'),
  }).optional().default({}),
  sale: z.object({
    number:           z.number().int().optional().nullable(),
    customerDocument: z.string().trim().min(11).max(18),
    salesmanDocument: z.string().trim().min(11).max(18),
  }),
  items: z.array(itemBody).optional(),
  totalizer: z.object({
    itemsQtde:       z.number().int(),
    productQtde:     z.number().optional().nullable(),
    productValue:    z.number().optional().nullable(),
    ipiValue:        z.number().optional().nullable(),
    discountAliquot: z.number().optional().nullable(),
    discountValue:   z.number().optional().nullable(),
    expensesValue:   z.number().optional().nullable(),
    totalValue:      z.number().optional().nullable(),
  }).optional(),
  billing: z.object({
    paymentTypeDescription: z.string().trim().min(1).max(45),
    plots:                  z.string().max(3).optional().nullable(),
    deadline:               z.string().max(255).optional().nullable(),
  }).optional(),
})

/** Papel precisa existir no schema do cliente (id = entity.id — D13). */
async function roleExists(
  conn: PoolConnection, table: string, entityId: number, institutionId: number
): Promise<boolean> {
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM ${table} WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
    [entityId, institutionId]
  )
  return rows.length > 0
}

/** tb_order.tb_user_id NOT NULL + FK central — usuário mais antigo do institution. */
async function resolveSyncUserId(conn: PoolConnection, institutionId: number): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT MIN(tb_user_id) AS uid FROM setes_central.tb_institution_has_user
     WHERE tb_institution_id = ? AND deleted = 'N'`,
    [institutionId]
  )
  const uid = rows[0]?.uid
  if (!uid) {
    throw new HttpError(409, 'Institution sem usuário para assinar o pedido',
      [{ field: 'id', message: 'cadastre um usuário do institution antes — reenvio no próximo ciclo' }],
      'INSTITUTION_USER_NOT_FOUND')
  }
  return uid
}

/**
 * @swagger
 * /order-sale/sincronize:
 *   post:
 *     summary: Sincronizar Pedido de Venda (id local + satélites em transação)
 *     description: >-
 *       Upsert de tb_order + tb_order_sale + tb_order_item (kind 'Sale') +
 *       tb_order_item_merchandise + tb_order_totalizer + tb_order_billing com
 *       id = PED_CODIGO e `terminal` do payload (dimensão das PKs).
 *       Cliente/vendedor por DOCUMENTO (409 CUSTOMER_NOT_SYNCED /
 *       SALESMAN_NOT_SYNCED); produto por id local (409 PRODUCT_NOT_SYNCED);
 *       forma de pagamento da cobrança por descrição (catálogo central).
 *       `items` presente = snapshot. deleted='S' = soft delete em cascata.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, sale]
 *             properties:
 *               id: { type: integer, example: 1001 }
 *               terminal: { type: integer, example: 0 }
 *               deleted: { type: string, enum: [S, N] }
 *               order:
 *                 type: object
 *                 properties:
 *                   dtRecord: { type: string, example: "2026-07-19" }
 *                   note: { type: string }
 *                   status: { type: string, maxLength: 1 }
 *                   origin: { type: string, maxLength: 1, example: "D" }
 *               sale:
 *                 type: object
 *                 required: [customerDocument, salesmanDocument]
 *                 properties:
 *                   number: { type: integer }
 *                   customerDocument: { type: string, example: "52998224725" }
 *                   salesmanDocument: { type: string, example: "11222333000181" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, productId, quantity, unitValue]
 *                   properties:
 *                     id: { type: integer, example: 1 }
 *                     productId: { type: integer, example: 501 }
 *                     quantity: { type: number, example: 2 }
 *                     unitValue: { type: number, example: 9.9 }
 *                     discountAliquot: { type: number }
 *                     discountValue: { type: number }
 *                     stockListId: { type: integer }
 *                     priceListId: { type: integer }
 *               totalizer:
 *                 type: object
 *                 required: [itemsQtde]
 *                 properties:
 *                   itemsQtde: { type: integer, example: 1 }
 *                   productQtde: { type: number }
 *                   productValue: { type: number }
 *                   ipiValue: { type: number }
 *                   discountAliquot: { type: number }
 *                   discountValue: { type: number }
 *                   expensesValue: { type: number }
 *                   totalValue: { type: number, example: 19.8 }
 *               billing:
 *                 type: object
 *                 required: [paymentTypeDescription]
 *                 properties:
 *                   paymentTypeDescription: { type: string, example: "DINHEIRO" }
 *                   plots: { type: string, maxLength: 3 }
 *                   deadline: { type: string }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Referência ainda não sincronizada — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/order-sale/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = orderSaleBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, terminal, deleted, order, sale, items, totalizer, billing } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // 1. Referências por DOCUMENTO (D3) — resolvem na CENTRAL
    const customerId = await findEntityIdByDocument(conn, sale.customerDocument)
    if (customerId === null) {
      throw new HttpError(409, `Cliente ${sale.customerDocument} ainda não sincronizado`,
        [{ field: 'sale.customerDocument', message: 'sincronize o cliente antes — reenvio no próximo ciclo' }],
        'CUSTOMER_NOT_SYNCED')
    }
    const salesmanId = await findEntityIdByDocument(conn, sale.salesmanDocument)
    if (salesmanId === null) {
      throw new HttpError(409, `Vendedor ${sale.salesmanDocument} ainda não sincronizado`,
        [{ field: 'sale.salesmanDocument', message: 'sincronize o vendedor antes — reenvio no próximo ciclo' }],
        'SALESMAN_NOT_SYNCED')
    }

    // 2. Forma de pagamento por DESCRIÇÃO (catálogo central)
    let paymentTypeId = 0
    if (billing) {
      const pt = await ensureCatalogItem(conn, 'tb_payment_types', billing.paymentTypeDescription)
      paymentTypeId = pt.id
    }

    const userId = await resolveSyncUserId(conn, institutionId)

    // 3. Schema do cliente — papéis precisam existir (D13)
    await conn.query(`USE \`${schemaName}\``)
    if (!await roleExists(conn, 'tb_customer', customerId, institutionId)) {
      throw new HttpError(409, `Cliente ${sale.customerDocument} ainda não sincronizado`,
        [{ field: 'sale.customerDocument', message: 'sincronize o cliente antes — reenvio no próximo ciclo' }],
        'CUSTOMER_NOT_SYNCED')
    }
    if (!await roleExists(conn, 'tb_salesman', salesmanId, institutionId)) {
      throw new HttpError(409, `Vendedor ${sale.salesmanDocument} ainda não sincronizado`,
        [{ field: 'sale.salesmanDocument', message: 'sincronize o vendedor antes — reenvio no próximo ciclo' }],
        'SALESMAN_NOT_SYNCED')
    }
    if (billing) {
      await upsertCatalogLink(conn, 'tb_institution_has_payment_types', 'tb_payment_types_id',
        institutionId, paymentTypeId)
    }

    // 4. tb_order (backbone)
    await conn.query(
      `INSERT INTO tb_order
         (id, tb_institution_id, terminal, tb_user_id, dt_record, note, origin, status, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         dt_record = VALUES(dt_record), note = VALUES(note), origin = VALUES(origin),
         status = VALUES(status), deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, terminal, userId, order.dtRecord ?? null, order.note ?? null,
       order.origin, order.status ?? null, deleted]
    )

    // 5. tb_order_sale (PK inclui tb_salesman_id — troca de vendedor desativa a linha antiga)
    await conn.query(
      `INSERT INTO tb_order_sale
         (id, tb_institution_id, terminal, tb_salesman_id, number, tb_customer_id, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         number = VALUES(number), tb_customer_id = VALUES(tb_customer_id),
         deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, terminal, salesmanId, sale.number ?? null, customerId, deleted]
    )
    await conn.query(
      `UPDATE tb_order_sale SET deleted = 'S', updated_at = NOW()
       WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND tb_salesman_id <> ? AND deleted = 'N'`,
      [id, institutionId, terminal, salesmanId]
    )

    // 6. Itens — SNAPSHOT quando o bloco vem (kind 'Sale' — DP6)
    if (items) {
      for (const item of items) {
        const [products] = await conn.query<any[]>(
          `SELECT id FROM tb_product WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
          [item.productId, institutionId]
        )
        if (!products.length) {
          throw new HttpError(409, `Produto ${item.productId} ainda não sincronizado`,
            [{ field: 'items.productId', message: 'sincronize o produto antes — reenvio no próximo ciclo' }],
            'PRODUCT_NOT_SYNCED')
        }
        await conn.query(
          `INSERT INTO tb_order_item
             (id, tb_institution_id, tb_order_id, terminal, kind, tb_product_id,
              quantity, unit_value, discount_aliquot, discount_value, deleted, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'Sale', ?, ?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             tb_product_id = VALUES(tb_product_id), quantity = VALUES(quantity),
             unit_value = VALUES(unit_value), discount_aliquot = VALUES(discount_aliquot),
             discount_value = VALUES(discount_value), deleted = VALUES(deleted), updated_at = NOW()`,
          [item.id, institutionId, id, terminal, item.productId, item.quantity, item.unitValue,
           item.discountAliquot ?? null, item.discountValue ?? null, deleted]
        )
        if (item.stockListId) {
          await conn.query(
            `INSERT INTO tb_order_item_merchandise
               (id, tb_institution_id, tb_order_id, terminal, tb_stock_list_id, tb_price_list_id, deleted, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
             ON DUPLICATE KEY UPDATE
               tb_stock_list_id = VALUES(tb_stock_list_id), tb_price_list_id = VALUES(tb_price_list_id),
               deleted = VALUES(deleted), updated_at = NOW()`,
            [item.id, institutionId, id, terminal, item.stockListId, item.priceListId ?? null, deleted]
          )
        }
      }
      // Snapshot: itens fora da lista saem do pedido (soft delete)
      const keptIds = items.map(i => i.id)
      await conn.query(
        `UPDATE tb_order_item SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND kind = 'Sale'
           AND deleted = 'N'${keptIds.length ? ' AND id NOT IN (?)' : ''}`,
        keptIds.length ? [id, institutionId, terminal, keptIds] : [id, institutionId, terminal]
      )
      const merchIds = items.filter(i => i.stockListId).map(i => i.id)
      await conn.query(
        `UPDATE tb_order_item_merchandise SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ?
           AND deleted = 'N'${merchIds.length ? ' AND id NOT IN (?)' : ''}`,
        merchIds.length ? [id, institutionId, terminal, merchIds] : [id, institutionId, terminal]
      )
    }

    // 7. Totalizador (PK id+institution+terminal = a do pedido)
    if (totalizer) {
      await conn.query(
        `INSERT INTO tb_order_totalizer
           (id, tb_institution_id, terminal, items_qtde, product_qtde, product_value, IPI_value,
            discount_aliquot, discount_value, expenses_value, total_value, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           items_qtde = VALUES(items_qtde), product_qtde = VALUES(product_qtde),
           product_value = VALUES(product_value), IPI_value = VALUES(IPI_value),
           discount_aliquot = VALUES(discount_aliquot), discount_value = VALUES(discount_value),
           expenses_value = VALUES(expenses_value), total_value = VALUES(total_value),
           deleted = VALUES(deleted), updated_at = NOW()`,
        [id, institutionId, terminal, totalizer.itemsQtde, totalizer.productQtde ?? null,
         totalizer.productValue ?? null, totalizer.ipiValue ?? null, totalizer.discountAliquot ?? null,
         totalizer.discountValue ?? null, totalizer.expensesValue ?? null, totalizer.totalValue ?? null,
         deleted]
      )
    }

    // 8. Cobrança
    if (billing) {
      await conn.query(
        `INSERT INTO tb_order_billing
           (id, tb_institution_id, terminal, tb_payment_types_id, plots, deadline, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           tb_payment_types_id = VALUES(tb_payment_types_id), plots = VALUES(plots),
           deadline = VALUES(deadline), deleted = VALUES(deleted), updated_at = NOW()`,
        [id, institutionId, terminal, paymentTypeId, billing.plots ?? null, billing.deadline ?? null, deleted]
      )
    }

    // 9. Soft delete em cascata (D2) — pega satélites fora do payload
    if (deleted === 'S') {
      for (const table of ['tb_order_sale', 'tb_order_totalizer', 'tb_order_billing']) {
        await conn.query(
          `UPDATE ${table} SET deleted = 'S', updated_at = NOW()
           WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
          [id, institutionId, terminal]
        )
      }
      for (const table of ['tb_order_item', 'tb_order_item_merchandise']) {
        await conn.query(
          `UPDATE ${table} SET deleted = 'S', updated_at = NOW()
           WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
          [id, institutionId, terminal]
        )
      }
    }

    await conn.commit()
    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /order-sale/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
