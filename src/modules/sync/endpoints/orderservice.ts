import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { PoolConnection } from 'mysql2/promise'
import { syncSuccess, syncError } from '../sync.response'
import { findEntityIdByDocument, getInstitutionDocument, resolveSelfSalesman } from '../sync.entity'
import { userRefBody, resolveUserId, resolveFallbackUserId } from '../sync.user'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { invoiceProcessBlock, resolveInvoiceRefs, upsertInvoice, InvoiceRefs } from './invoice'
import { serviceRamoBlock, upsertServiceRamo } from './invoiceservice'
import { merchandiseRamoBlock, upsertMerchandiseRamo } from './invoicemerchandise'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * ORDEM DE SERVIÇO COMPLETA — decisões D1/D6/D9/D13 do
 * prompt_notas_mercadoria_servico.md. id = NFL_CODIGO (D1: a nota mista
 * vincula TODO o processo — mesma identidade do módulo nativo Software
 * House). RODADA 3 (D13): a ordem CONJUGADA entra INTEIRA por aqui — quando
 * o pedido tem itens de mercadoria, os blocos `sale` (vendedor) e
 * `saleItems` (itens kind 'Sale' + item_merchandise) viajam junto, e o
 * `invoice.merchandise` grava o segundo ramo da nota; o /order-sale fica
 * para vendas PURAS (sem itens de serviço — filtros DISJUNTOS no Delphi).
 * Snapshots ESCOPADOS por kind ('Service' e 'Sale' separados).
 * Totalizer/billing são ÚNICOS do pedido ("listas separadas, totalizadas
 * juntas"). Cliente por DOCUMENTO (D3) com papel verificado; o ramo
 * tb_order_service não tem vendedor (number + tb_customer_id; open_lock
 * NULL — a UNIQUE da tela de processo aceita N nulls). AUTOR via bloco
 * `user`. deleted='S' = pedido inteiro: derruba TODOS os ramos e itens.
 * Contrato: CONTRATOS_SYNC.md.
 */
const itemBody = z.object({
  id:              z.number().int().positive(),
  productId:       z.number().int().positive(),
  quantity:        z.number(),
  unitValue:       z.number(),
  discountAliquot: z.number().optional().nullable(),
  discountValue:   z.number().optional().nullable(),
})

// Itens de MERCADORIA da ordem conjugada (D13) — mesmos campos do /order-sale
const saleItemBody = itemBody.extend({
  stockListId: z.number().int().positive().optional().nullable(),
  priceListId: z.number().int().positive().optional().nullable(),
})

const orderServiceBody = z.object({
  id:       z.number().int().positive(),
  terminal: z.number().int().min(0),
  deleted:  z.enum(['S', 'N']).optional().default('N'),
  order: z.object({
    dtRecord: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    note:     z.string().optional().nullable(),
    status:   z.string().max(1).optional().nullable(),
    origin:   z.string().max(1).optional().default('D'),
  }).optional().default({}),
  service: z.object({
    number:           z.number().int().optional().nullable(),
    customerDocument: z.string().trim().min(11).max(18),
  }),
  items: z.array(itemBody).optional(),
  // Rodada 3 (D13): ordem de serviço CONJUGADA entra INTEIRA por aqui — o ramo
  // de venda viaja junto quando o pedido tem itens de mercadoria.
  sale: z.object({
    number:           z.number().int().optional().nullable(),
    customerDocument: z.string().trim().min(11).max(18).optional(),  // ausente = o do service
    salesmanDocument: z.string().trim().min(11).max(18),
  }).optional(),
  saleItems: z.array(saleItemBody).optional(),
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
  user: userRefBody.optional(),
  // Rodada 2 (D9/D10): objeto COMPLETO — a nota viaja junto do pedido e é
  // gravada na MESMA transação (ramo tb_invoice_service; na conjugada, o
  // ramo merchandise vem junto — presença = tem parte mercadoria, D13).
  invoice: invoiceProcessBlock.extend({
    service:     serviceRamoBlock.optional().default({}),
    merchandise: merchandiseRamoBlock.optional(),
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

/**
 * @swagger
 * /order-service/sincronize:
 *   post:
 *     summary: Sincronizar Pedido de Serviço (ramo tb_order_service, id = NFL_CODIGO)
 *     description: >-
 *       Upsert de tb_order + tb_order_service + tb_order_item (kind 'Service')
 *       + tb_order_totalizer + tb_order_billing. Pedido CONJUGADO = mesmo id
 *       do /order-sale, cada endpoint alimenta seu ramo; snapshot de itens
 *       escopado por kind='Service'. Cliente por DOCUMENTO (409
 *       CUSTOMER_NOT_SYNCED); produto por id local (409 PRODUCT_NOT_SYNCED);
 *       autor via bloco user (409 USER_NOT_SYNCED). deleted='S' = soft delete
 *       do ramo + itens Service + totalizer/billing.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, service]
 *             properties:
 *               id: { type: integer, example: 1001, description: NFL_CODIGO (D1 — vincula todo o processo) }
 *               terminal: { type: integer, example: 0 }
 *               deleted: { type: string, enum: [S, N] }
 *               order:
 *                 type: object
 *                 properties:
 *                   dtRecord: { type: string, example: "2026-07-26" }
 *                   note: { type: string }
 *                   status: { type: string, maxLength: 1 }
 *                   origin: { type: string, maxLength: 1, example: "D" }
 *               service:
 *                 type: object
 *                 required: [customerDocument]
 *                 properties:
 *                   number: { type: integer, example: 55 }
 *                   customerDocument: { type: string, example: "52998224725" }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, productId, quantity, unitValue]
 *                   properties:
 *                     id: { type: integer, example: 1 }
 *                     productId: { type: integer, example: 501, description: produto kind='S' }
 *                     quantity: { type: number, example: 1 }
 *                     unitValue: { type: number, example: 80 }
 *                     discountAliquot: { type: number }
 *                     discountValue: { type: number }
 *               totalizer:
 *                 type: object
 *                 required: [itemsQtde]
 *                 properties:
 *                   itemsQtde: { type: integer, example: 2 }
 *                   productQtde: { type: number }
 *                   productValue: { type: number }
 *                   ipiValue: { type: number }
 *                   discountAliquot: { type: number }
 *                   discountValue: { type: number }
 *                   expensesValue: { type: number }
 *                   totalValue: { type: number, example: 99.8 }
 *               billing:
 *                 type: object
 *                 required: [paymentTypeDescription]
 *                 properties:
 *                   paymentTypeDescription: { type: string, example: "DINHEIRO" }
 *                   plots: { type: string, maxLength: 3 }
 *                   deadline: { type: string }
 *               user:
 *                 type: object
 *                 description: Autor do pedido — exatamente UM dos campos (ausente = fallback de transição)
 *                 properties:
 *                   userDocument: { type: string, example: "52998224725" }
 *                   userExternalCode: { type: string, format: uuid }
 *               sale:
 *                 type: object
 *                 description: Conjugada (D13) — ramo de VENDA do mesmo pedido (vendedor obrigatório; customerDocument ausente = o do service)
 *                 required: [salesmanDocument]
 *                 properties:
 *                   number: { type: integer, example: 55 }
 *                   customerDocument: { type: string }
 *                   salesmanDocument: { type: string, example: "52998224725" }
 *               saleItems:
 *                 type: array
 *                 description: Conjugada (D13) — itens de MERCADORIA (kind 'Sale'; mesmos campos dos items do /order-sale, com stockListId/priceListId)
 *                 items:
 *                   type: object
 *                   required: [id, productId, quantity, unitValue]
 *                   properties:
 *                     id: { type: integer, example: 1 }
 *                     productId: { type: integer, example: 501 }
 *                     quantity: { type: number, example: 2 }
 *                     unitValue: { type: number, example: 9.9 }
 *                     stockListId: { type: integer }
 *                     priceListId: { type: integer }
 *               invoice:
 *                 type: object
 *                 description: >-
 *                   Objeto COMPLETO (rodada 2 D9/D10) — a nota do processo, gravada na
 *                   mesma transação (campos do /invoice sem id/terminal/deleted) +
 *                   ramo service; na conjugada (D13), o ramo merchandise vem junto
 *                   (presença = a nota também é de mercadoria).
 *                 properties:
 *                   kindEmis: { type: string, example: "SE" }
 *                   number: { type: string, example: "000124" }
 *                   entityDocument: { type: string, example: "52998224725" }
 *                   dtEmission: { type: string, example: "2026-07-27" }
 *                   value: { type: number, example: 99.8 }
 *                   status: { type: string, example: "A" }
 *                   service:
 *                     type: object
 *                     properties:
 *                       totalValue: { type: number, example: 80, description: NFL_VL_TL_SRV }
 *                   merchandise:
 *                     type: object
 *                     description: Ramo de mercadoria da nota conjugada (mesmos campos do /invoice-merchandise)
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Referência ainda não sincronizada — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/order-service/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = orderServiceBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, terminal, deleted, order, service, items, totalizer, billing, user, invoice,
            sale, saleItems } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // 0. Refs da NOTA (rodada 2 — D9): resolvidas na central, antes do USE
    let invoiceRefs: InvoiceRefs | null = null
    if (invoice) {
      invoiceRefs = await resolveInvoiceRefs(conn, { ...invoice, id, terminal, deleted })
    }

    // 1. Cliente por DOCUMENTO (D3) — resolve na CENTRAL
    const customerId = await findEntityIdByDocument(conn, service.customerDocument)
    if (customerId === null) {
      throw new HttpError(409, `Cliente ${service.customerDocument} ainda não sincronizado`,
        [{ field: 'service.customerDocument', message: 'sincronize o cliente antes — reenvio no próximo ciclo' }],
        'CUSTOMER_NOT_SYNCED')
    }

    // 1b. Conjugada (D13): vendedor do ramo de venda, quando o bloco `sale` veio
    let salesmanId: number | null = null
    let isSelfSalesman = false
    let saleCustomerId = customerId
    if (sale) {
      // Vendedor = a PRÓPRIA empresa (2026-08-09): ver ordersale.ts — legado
      // grava o EMP_CODIGO da loja como vendedor em venda de balcão sem
      // representante; a institution vira seu próprio fallback.
      const institutionDoc = await getInstitutionDocument(conn, institutionId)
      if (institutionDoc && institutionDoc === sale.salesmanDocument.replace(/\D/g, '')) {
        await resolveSelfSalesman(conn, institutionId, schemaName)
        salesmanId = institutionId
        isSelfSalesman = true
      } else {
        const found = await findEntityIdByDocument(conn, sale.salesmanDocument)
        if (found === null) {
          throw new HttpError(409, `Vendedor ${sale.salesmanDocument} ainda não sincronizado`,
            [{ field: 'sale.salesmanDocument', message: 'sincronize o vendedor antes — reenvio no próximo ciclo' }],
            'SALESMAN_NOT_SYNCED')
        }
        salesmanId = found
      }
      if (sale.customerDocument && sale.customerDocument !== service.customerDocument) {
        const saleCust = await findEntityIdByDocument(conn, sale.customerDocument)
        if (saleCust === null) {
          throw new HttpError(409, `Cliente ${sale.customerDocument} ainda não sincronizado`,
            [{ field: 'sale.customerDocument', message: 'sincronize o cliente antes — reenvio no próximo ciclo' }],
            'CUSTOMER_NOT_SYNCED')
        }
        saleCustomerId = saleCust
      }
    }

    // 2. Forma de pagamento por DESCRIÇÃO (catálogo central)
    let paymentTypeId = 0
    if (billing) {
      const pt = await ensureCatalogItem(conn, 'tb_payment_types', billing.paymentTypeDescription)
      paymentTypeId = pt.id
    }

    const userId = user
      ? await resolveUserId(conn, user, institutionId)
      : await resolveFallbackUserId(conn, institutionId)

    // 3. Schema do cliente — papéis precisam existir (D13 da revisão)
    await conn.query(`USE \`${schemaName}\``)
    if (!await roleExists(conn, 'tb_customer', customerId, institutionId)) {
      throw new HttpError(409, `Cliente ${service.customerDocument} ainda não sincronizado`,
        [{ field: 'service.customerDocument', message: 'sincronize o cliente antes — reenvio no próximo ciclo' }],
        'CUSTOMER_NOT_SYNCED')
    }
    if (sale && salesmanId !== null && !isSelfSalesman && !await roleExists(conn, 'tb_salesman', salesmanId, institutionId)) {
      throw new HttpError(409, `Vendedor ${sale.salesmanDocument} ainda não sincronizado`,
        [{ field: 'sale.salesmanDocument', message: 'sincronize o vendedor antes — reenvio no próximo ciclo' }],
        'SALESMAN_NOT_SYNCED')
    }
    if (billing) {
      await upsertCatalogLink(conn, 'tb_institution_has_payment_types', 'tb_payment_types_id',
        institutionId, paymentTypeId)
    }

    // 4. tb_order (backbone — mesmo upsert do /order-sale, idempotente no conjugado)
    await conn.query(
      `INSERT INTO tb_order
         (id, tb_institution_id, terminal, tb_user_id, dt_record, note, origin, status, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         ${user ? 'tb_user_id = VALUES(tb_user_id),' : ''}
         dt_record = VALUES(dt_record), note = VALUES(note), origin = VALUES(origin),
         status = VALUES(status), deleted = VALUES(deleted), updated_at = NOW()`,
      // tb_user_id só atualiza quando o bloco `user` veio — o fallback de
      // transição nunca sobrescreve um autor real já gravado.
      [id, institutionId, terminal, userId, order.dtRecord ?? null, order.note ?? null,
       order.origin, order.status ?? null, deleted]
    )

    // 5. tb_order_service (ramo — open_lock NULL: pedido do sync já nasce fechado)
    await conn.query(
      `INSERT INTO tb_order_service
         (id, tb_institution_id, terminal, number, tb_customer_id, open_lock, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         number = VALUES(number), tb_customer_id = VALUES(tb_customer_id),
         deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, terminal, service.number ?? null, customerId, deleted]
    )

    // 5b. Conjugada (D13): ramo de VENDA no MESMO order, quando o pedido tem parte mercadoria
    if (sale && salesmanId !== null) {
      await conn.query(
        `INSERT INTO tb_order_sale
           (id, tb_institution_id, terminal, tb_salesman_id, number, tb_customer_id, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           number = VALUES(number), tb_customer_id = VALUES(tb_customer_id),
           deleted = VALUES(deleted), updated_at = NOW()`,
        [id, institutionId, terminal, salesmanId, sale.number ?? null, saleCustomerId, deleted]
      )
      await conn.query(
        `UPDATE tb_order_sale SET deleted = 'S', updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND tb_salesman_id <> ? AND deleted = 'N'`,
        [id, institutionId, terminal, salesmanId]
      )
    }

    // 5c. Itens de MERCADORIA da conjugada — SNAPSHOT ESCOPADO por kind='Sale'
    if (saleItems) {
      for (const item of saleItems) {
        const [products] = await conn.query<any[]>(
          `SELECT id FROM tb_product WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
          [item.productId, institutionId]
        )
        if (!products.length) {
          throw new HttpError(409, `Produto ${item.productId} ainda não sincronizado`,
            [{ field: 'saleItems.productId', message: 'sincronize o produto antes — reenvio no próximo ciclo' }],
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
      const keptSaleIds = saleItems.map(i => i.id)
      await conn.query(
        `UPDATE tb_order_item SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND kind = 'Sale'
           AND deleted = 'N'${keptSaleIds.length ? ' AND id NOT IN (?)' : ''}`,
        keptSaleIds.length ? [id, institutionId, terminal, keptSaleIds] : [id, institutionId, terminal]
      )
      const merchIds = saleItems.filter(i => i.stockListId).map(i => i.id)
      await conn.query(
        `UPDATE tb_order_item_merchandise SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ?
           AND deleted = 'N'${merchIds.length ? ' AND id NOT IN (?)' : ''}`,
        merchIds.length ? [id, institutionId, terminal, merchIds] : [id, institutionId, terminal]
      )
    }

    // 6. Itens — SNAPSHOT ESCOPADO por kind='Service' (D6)
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
           VALUES (?, ?, ?, ?, 'Service', ?, ?, ?, ?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE
             tb_product_id = VALUES(tb_product_id), quantity = VALUES(quantity),
             unit_value = VALUES(unit_value), discount_aliquot = VALUES(discount_aliquot),
             discount_value = VALUES(discount_value), deleted = VALUES(deleted), updated_at = NOW()`,
          [item.id, institutionId, id, terminal, item.productId, item.quantity, item.unitValue,
           item.discountAliquot ?? null, item.discountValue ?? null, deleted]
        )
      }
      const keptIds = items.map(i => i.id)
      await conn.query(
        `UPDATE tb_order_item SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND kind = 'Service'
           AND deleted = 'N'${keptIds.length ? ' AND id NOT IN (?)' : ''}`,
        keptIds.length ? [id, institutionId, terminal, keptIds] : [id, institutionId, terminal]
      )
    }

    // 7. Totalizador — ÚNICO do pedido (as duas classes enviam os mesmos valores)
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

    // 9. NOTA do processo (rodada 2 — D9/D10): tb_invoice + ramo serviço
    // na MESMA transação do pedido (id compartilhado — D1)
    if (invoice && invoiceRefs) {
      await upsertInvoice(conn, institutionId, { ...invoice, id, terminal, deleted }, invoiceRefs)
      await upsertServiceRamo(conn, institutionId, id, terminal, invoice.service, deleted)
      // Conjugada (D13): ramo de mercadoria presente = nota também é de mercadoria
      if (invoice.merchandise) {
        await upsertMerchandiseRamo(conn, institutionId, id, terminal, invoice.merchandise, deleted)
      }
    }

    // 10. Soft delete em cascata (D2) — a conjugada entra INTEIRA por aqui (D13),
    // então a cascata cobre TODOS os ramos e itens do pedido
    if (deleted === 'S') {
      for (const table of ['tb_order_service', 'tb_order_sale', 'tb_order_totalizer', 'tb_order_billing']) {
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
    logger.error('Erro em /order-service/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
