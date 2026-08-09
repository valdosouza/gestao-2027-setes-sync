import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { findEntityIdByDocument } from '../sync.entity'
import { userRefBody, resolveUserId, resolveFallbackUserId } from '../sync.user'
import { invoiceProcessBlock, resolveInvoiceRefs, upsertInvoice, InvoiceRefs } from './invoice'
import { merchandiseRamoBlock, upsertMerchandiseRamo } from './invoicemerchandise'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Pedido de COMPRA (Onda 5). ID LOCAL ✅ (MAPA_INDEXACAO): PED_CODIGO É o
 * id na web (tb_order, PK id+institution+terminal — `terminal` do payload).
 * Fornecedor por DOCUMENTO (D3): providerDocument → entity na central +
 * papel tb_provider no schema → 409 PROVIDER_NOT_SYNCED (reenvio no próximo
 * ciclo). Produto do item por id local → 409 PRODUCT_NOT_SYNCED. `items`
 * presente = SNAPSHOT (kind fixo 'Purchase'). AUTOR
 * (prompt_indexacao_usuario_firebird.md): bloco `user` opcional resolve o
 * tb_user_id real (409 USER_NOT_SYNCED); ausente → fallback de transição
 * (decisão 5). Reenvio COM bloco corrige o autor.
 * Transação ÚNICA; deleted='S' em cascata (D2).
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

const orderPurchaseBody = z.object({
  id:       z.number().int().positive(),
  terminal: z.number().int().min(0),
  deleted:  z.enum(['S', 'N']).optional().default('N'),
  order: z.object({
    dtRecord: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    note:     z.string().optional().nullable(),
    status:   z.string().max(1).optional().nullable(),
    origin:   z.string().max(1).optional().default('D'),
  }).optional().default({}),
  purchase: z.object({
    number:           z.number().int().optional().nullable(),
    providerDocument: z.string().trim().min(11).max(18),
    approved:         z.enum(['S', 'N']).optional().nullable(),
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
  user: userRefBody.optional(),
  // Rodada 2 (D9/D10): objeto COMPLETO — a nota de entrada viaja junto do
  // pedido e é gravada na MESMA transação (ramo tb_invoice_merchandise).
  invoice: invoiceProcessBlock.extend({
    merchandise: merchandiseRamoBlock.optional().default({}),
  }).optional(),
})

/**
 * @swagger
 * /order-purchase/sincronize:
 *   post:
 *     summary: Sincronizar Pedido de Compra (id local + satélites em transação)
 *     description: >-
 *       Upsert de tb_order + tb_order_purchase + tb_order_item (kind
 *       'Purchase') + tb_order_totalizer (opcional) com id = PED_CODIGO e
 *       `terminal` do payload. Fornecedor por DOCUMENTO (409
 *       PROVIDER_NOT_SYNCED); produto por id local (409 PRODUCT_NOT_SYNCED).
 *       `items` presente = snapshot. deleted='S' = soft delete em cascata.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, terminal, purchase]
 *             properties:
 *               id: { type: integer, example: 2001 }
 *               terminal: { type: integer, example: 0 }
 *               deleted: { type: string, enum: [S, N] }
 *               order:
 *                 type: object
 *                 properties:
 *                   dtRecord: { type: string, example: "2026-07-19" }
 *                   note: { type: string }
 *                   status: { type: string, maxLength: 1 }
 *                   origin: { type: string, maxLength: 1, example: "D" }
 *               purchase:
 *                 type: object
 *                 required: [providerDocument]
 *                 properties:
 *                   number: { type: integer }
 *                   providerDocument: { type: string, example: "11222333000181" }
 *                   approved: { type: string, enum: [S, N] }
 *               user:
 *                 type: object
 *                 description: Autor do pedido — exatamente UM dos campos (ausente = fallback de transição)
 *                 properties:
 *                   userDocument: { type: string, example: "52998224725" }
 *                   userExternalCode: { type: string, format: uuid }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [id, productId, quantity, unitValue]
 *                   properties:
 *                     id: { type: integer, example: 1 }
 *                     productId: { type: integer, example: 501 }
 *                     quantity: { type: number, example: 10 }
 *                     unitValue: { type: number, example: 5.5 }
 *                     discountAliquot: { type: number }
 *                     discountValue: { type: number }
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
 *                   totalValue: { type: number, example: 55 }
 *               invoice:
 *                 type: object
 *                 description: >-
 *                   Objeto COMPLETO (rodada 2 D9/D10) — a nota de ENTRADA do processo,
 *                   gravada na mesma transação (campos do /invoice sem id/terminal/deleted;
 *                   issuer 'N' com entityDocument do fornecedor) + bloco merchandise.
 *                 properties:
 *                   issuer: { type: string, enum: [S, N], example: "N" }
 *                   kindEmis: { type: string, example: "EE" }
 *                   number: { type: string, example: "000124" }
 *                   entityDocument: { type: string, example: "11222333000181" }
 *                   dtEmission: { type: string, example: "2026-07-27" }
 *                   value: { type: number, example: 55 }
 *                   merchandise:
 *                     type: object
 *                     description: Ramo de mercadoria (mesmos campos do /invoice-merchandise)
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Referência ainda não sincronizada — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/order-purchase/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = orderPurchaseBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, terminal, deleted, order, purchase, items, totalizer, user, invoice } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // 0. Refs da NOTA (rodada 2 — D9): resolvidas na central, antes do USE
    let invoiceRefs: InvoiceRefs | null = null
    if (invoice) {
      invoiceRefs = await resolveInvoiceRefs(conn, { ...invoice, id, terminal, deleted })
    }

    // 1. Fornecedor por DOCUMENTO (D3) — entity na central + papel no schema
    const providerId = await findEntityIdByDocument(conn, purchase.providerDocument)
    if (providerId === null) {
      throw new HttpError(409, `Fornecedor ${purchase.providerDocument} ainda não sincronizado`,
        [{ field: 'purchase.providerDocument', message: 'sincronize o fornecedor antes — reenvio no próximo ciclo' }],
        'PROVIDER_NOT_SYNCED')
    }

    const userId = user
      ? await resolveUserId(conn, user, institutionId)
      : await resolveFallbackUserId(conn, institutionId)

    await conn.query(`USE \`${schemaName}\``)
    const [providers] = await conn.query<any[]>(
      `SELECT id FROM tb_provider WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
      [providerId, institutionId]
    )
    if (!providers.length) {
      throw new HttpError(409, `Fornecedor ${purchase.providerDocument} ainda não sincronizado`,
        [{ field: 'purchase.providerDocument', message: 'sincronize o fornecedor antes — reenvio no próximo ciclo' }],
        'PROVIDER_NOT_SYNCED')
    }

    // 2. tb_order (backbone)
    await conn.query(
      `INSERT INTO tb_order
         (id, tb_institution_id, terminal, tb_user_id, dt_record, note, origin, status, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         ${user ? 'tb_user_id = VALUES(tb_user_id),' : ''}
         dt_record = VALUES(dt_record), note = VALUES(note), origin = VALUES(origin),
         status = VALUES(status), deleted = VALUES(deleted), updated_at = NOW()`,
      // tb_user_id só atualiza quando o bloco `user` veio (decisão 5).
      [id, institutionId, terminal, userId, order.dtRecord ?? null, order.note ?? null,
       order.origin, order.status ?? null, deleted]
    )

    // 3. tb_order_purchase
    await conn.query(
      `INSERT INTO tb_order_purchase
         (id, tb_institution_id, terminal, number, tb_provider_id, approved, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         number = VALUES(number), tb_provider_id = VALUES(tb_provider_id),
         approved = VALUES(approved), deleted = VALUES(deleted), updated_at = NOW()`,
      [id, institutionId, terminal, purchase.number ?? null, providerId, purchase.approved ?? null, deleted]
    )

    // 4. Itens — SNAPSHOT quando o bloco vem (kind 'Purchase')
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
           VALUES (?, ?, ?, ?, 'Purchase', ?, ?, ?, ?, ?, ?, NOW(), NOW())
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
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND kind = 'Purchase'
           AND deleted = 'N'${keptIds.length ? ' AND id NOT IN (?)' : ''}`,
        keptIds.length ? [id, institutionId, terminal, keptIds] : [id, institutionId, terminal]
      )
    }

    // 5. Totalizador (opcional)
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

    // 6. NOTA do processo (rodada 2 — D9/D10): tb_invoice + ramo mercadoria
    if (invoice && invoiceRefs) {
      await upsertInvoice(conn, institutionId, { ...invoice, id, terminal, deleted }, invoiceRefs)
      await upsertMerchandiseRamo(conn, institutionId, id, terminal, invoice.merchandise, deleted)
    }

    // 7. Soft delete em cascata (D2)
    if (deleted === 'S') {
      for (const table of ['tb_order_purchase', 'tb_order_totalizer']) {
        await conn.query(
          `UPDATE ${table} SET deleted = 'S', updated_at = NOW()
           WHERE id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
          [id, institutionId, terminal]
        )
      }
      await conn.query(
        `UPDATE tb_order_item SET deleted = 'S', updated_at = NOW()
         WHERE tb_order_id = ? AND tb_institution_id = ? AND terminal = ? AND deleted = 'N'`,
        [id, institutionId, terminal]
      )
    }

    await conn.commit()
    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /order-purchase/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
