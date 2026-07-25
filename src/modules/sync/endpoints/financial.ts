import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Financeiro (títulos) — Onda 5. Grava o FORMATO NOVO da 5.5 (Software
 * House): tb_financial com PK NATURAL (institution, order, terminal,
 * parcel) — o FIN_CODIGO do Firebird NÃO viaja (id vestigial no modelo
 * novo); o vínculo é o PEDIDO (orderId = FIN_CODNFL local ✅) + parcela.
 *
 * SEMÂNTICA DE ESPELHO (decisão da revisão, registrada no MAPA): o
 * financeiro novo é IMUTÁVEL por eventos (payments N/E/R), mas o Firebird
 * só conhece o ESTADO ATUAL — o sync grava a baixa como evento 1 status
 * 'N' via upsert. Histórico de estornos do legado NÃO viaja; a partir do
 * cutover, eventos nascem na web com a imutabilidade plena.
 * Contrato: CONTRATOS_SYNC.md.
 */
const financialBody = z.object({
  orderId:                z.number().int().positive(),
  terminal:               z.number().int().min(0),
  parcel:                 z.number().int().positive(),
  dtExpiration:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tagValue:               z.number(),
  paymentTypeDescription: z.string().trim().min(1).max(45).optional(),
  deleted:                z.enum(['S', 'N']).optional().default('N'),
  payment: z.object({
    paidValue:        z.number(),
    dtPayment:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    dtRealPayment:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    interestValue:    z.number().nullable().optional(),
    lateValue:        z.number().nullable().optional(),
    discountAliquot:  z.number().nullable().optional(),
    settledCode:      z.number().int().nullable().optional(),
    financialPlansId: z.number().int().nullable().optional(),
  }).optional(),
})

/**
 * @swagger
 * /financial/sincronize:
 *   post:
 *     summary: Sincronizar título financeiro (formato novo 5.5 — espelho)
 *     description: >-
 *       Upsert em tb_financial pela PK natural (institution, order,
 *       terminal, parcel). Bloco payment presente = baixa espelhada como
 *       evento 1 status 'N'. Pedido inexistente = 409 ORDER_NOT_SYNCED.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id } — id = orderId" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Pedido/plano ainda não sincronizado }
 *       500: { description: Erro ao processar }
 */
router.post('/financial/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = financialBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const f = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // Forma de pagamento por descrição (catálogo central) — antes do USE
    let paymentTypeId = 0
    if (f.paymentTypeDescription) {
      const pt = await ensureCatalogItem(conn, 'tb_payment_types', f.paymentTypeDescription)
      paymentTypeId = pt.id
    }

    await conn.query(`USE \`${schemaName}\``)
    if (f.paymentTypeDescription) {
      await upsertCatalogLink(conn, 'tb_institution_has_payment_types', 'tb_payment_types_id',
        institutionId, paymentTypeId)
    }

    const [orders] = await conn.query<any[]>(
      `SELECT id FROM tb_order WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
      [f.orderId, institutionId]
    )
    if (!orders.length) {
      throw new HttpError(409, `Pedido ${f.orderId} ainda não sincronizado`,
        [{ field: 'orderId', message: 'sincronize o pedido antes — reenvio no próximo ciclo' }],
        'ORDER_NOT_SYNCED')
    }

    if (f.payment?.financialPlansId) {
      const [plans] = await conn.query<any[]>(
        `SELECT id FROM tb_financial_plans WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
        [f.payment.financialPlansId, institutionId]
      )
      if (!plans.length) {
        throw new HttpError(409, `Plano de contas ${f.payment.financialPlansId} ainda não sincronizado`,
          [{ field: 'payment.financialPlansId', message: 'sincronize o plano antes — reenvio no próximo ciclo' }],
          'FINANCIAL_PLAN_NOT_SYNCED')
      }
    }

    await conn.query(
      `INSERT INTO tb_financial
         (tb_institution_id, tb_order_id, terminal, parcel, dt_expiration,
          tb_payment_types_id, tag_value, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         dt_expiration = VALUES(dt_expiration),
         tb_payment_types_id = IF(VALUES(tb_payment_types_id) > 0, VALUES(tb_payment_types_id), tb_payment_types_id),
         tag_value = VALUES(tag_value), deleted = VALUES(deleted), updated_at = NOW()`,
      [institutionId, f.orderId, f.terminal, f.parcel, f.dtExpiration,
       paymentTypeId, f.tagValue, f.deleted]
    )

    // Baixa espelhada — evento 1, status 'N' (ver comentário do arquivo)
    if (f.payment) {
      const p = f.payment
      await conn.query(
        `INSERT INTO tb_financial_payment
           (tb_institution_id, tb_order_id, terminal, parcel, event,
            interest_value, late_value, discount_aliquot, paid_value,
            dt_payment, dt_real_payment, settled, tb_financial_plans_id,
            settled_code, tb_payment_types_id, status, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'S', ?, ?, ?, 'N', 'N', NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           interest_value = VALUES(interest_value), late_value = VALUES(late_value),
           discount_aliquot = VALUES(discount_aliquot), paid_value = VALUES(paid_value),
           dt_payment = VALUES(dt_payment), dt_real_payment = VALUES(dt_real_payment),
           settled = 'S', tb_financial_plans_id = VALUES(tb_financial_plans_id),
           settled_code = VALUES(settled_code),
           tb_payment_types_id = VALUES(tb_payment_types_id),
           status = 'N', deleted = 'N', updated_at = NOW()`,
        [institutionId, f.orderId, f.terminal, f.parcel,
         p.interestValue ?? 0, p.lateValue ?? 0, p.discountAliquot ?? 0, p.paidValue,
         p.dtPayment ?? null, p.dtRealPayment ?? null,
         p.financialPlansId ?? 0, p.settledCode ?? 0, paymentTypeId]
      )
    }

    await conn.commit()
    res.json(syncSuccess(f.orderId))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /financial/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
