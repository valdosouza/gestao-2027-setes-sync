import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { userRefBody, resolveUserId } from '../sync.user'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Movimento Financeiro (extrato) — Onda 5. Id local ✅ (MVF_CODIGO).
 * Formato novo da 5.5: status default 'N' (espelho — estornos do legado
 * não viajam como eventos; ver semântica no financial.ts) e
 * tb_financial_statement_id_origin sempre NULL no sync. Conta bancária
 * por id local (Onda 4); forma de pagamento por descrição.
 * AUTOR (prompt_indexacao_usuario_firebird.md, decisão 6): bloco `user`
 * opcional resolve tb_user_id = entity.id do usuário do legado (409
 * USER_NOT_SYNCED); ausente → 0 sentinela (comportamento anterior).
 * Reenvio COM bloco corrige o autor.
 * Contrato: CONTRATOS_SYNC.md.
 */
const statementBody = z.object({
  id:                     z.number().int().positive(),
  terminal:               z.number().int().min(0),
  bankAccountId:          z.number().int().nullable().optional(),
  dtRecord:               z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bankHistoricId:         z.number().int().nullable().optional(),
  creditValue:            z.number().nullable().optional(),
  debitValue:             z.number().nullable().optional(),
  manualHistory:          z.string().max(255).nullable().optional(),
  kind:                   z.string().max(1).nullable().optional(),
  settledCode:            z.number().int().nullable().optional(),
  future:                 z.enum(['S', 'N']).optional().default('N'),
  dtOriginal:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  docReference:           z.string().max(45).nullable().optional(),
  conferred:              z.enum(['S', 'N']).optional().default('N'),
  paymentTypeDescription: z.string().trim().min(1).max(45).optional(),
  financialPlansIdCre:    z.number().int().nullable().optional(),
  financialPlansIdDeb:    z.number().int().nullable().optional(),
  deleted:                z.enum(['S', 'N']).optional().default('N'),
  user:                   userRefBody.optional(),
})

/**
 * @swagger
 * /financial-statement/sincronize:
 *   post:
 *     summary: Sincronizar movimento financeiro (extrato — id local)
 *     description: >-
 *       Upsert em tb_financial_statement (id = MVF_CODIGO). Conta bancária
 *       inexistente = 409 BANK_ACCOUNT_NOT_SYNCED. status 'N' (espelho).
 *       Bloco `user` opcional (userDocument OU userExternalCode) resolve o
 *       autor (409 USER_NOT_SYNCED); ausente → tb_user_id 0 sentinela.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Conta bancária ainda não sincronizada }
 *       500: { description: Erro ao processar }
 */
router.post('/financial-statement/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = statementBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const s = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // Autor (decisão 6) — resolve na central ANTES do USE
    const userId = s.user ? await resolveUserId(conn, s.user, institutionId) : 0

    let paymentTypeId = 0
    if (s.paymentTypeDescription) {
      const pt = await ensureCatalogItem(conn, 'tb_payment_types', s.paymentTypeDescription)
      paymentTypeId = pt.id
    }

    await conn.query(`USE \`${schemaName}\``)
    if (s.paymentTypeDescription) {
      await upsertCatalogLink(conn, 'tb_institution_has_payment_types', 'tb_payment_types_id',
        institutionId, paymentTypeId)
    }

    if (s.bankAccountId) {
      const [accounts] = await conn.query<any[]>(
        `SELECT id FROM tb_bank_account WHERE id = ? AND tb_institution_id = ? LIMIT 1`,
        [s.bankAccountId, institutionId]
      )
      if (!accounts.length) {
        throw new HttpError(409, `Conta bancária ${s.bankAccountId} ainda não sincronizada`,
          [{ field: 'bankAccountId', message: 'sincronize a conta antes — reenvio no próximo ciclo' }],
          'BANK_ACCOUNT_NOT_SYNCED')
      }
    }

    await conn.query(
      `INSERT INTO tb_financial_statement
         (id, tb_institution_id, terminal, tb_bank_account_id, dt_record,
          tb_bank_historic_id, credit_value, debit_value, manual_history, kind,
          settled_code, tb_user_id, future, dt_original, doc_reference, conferred,
          tb_payment_types_id, tb_financial_plans_id_cre, tb_financial_plans_id_deb,
          status, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'N', ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         ${s.user ? 'tb_user_id = VALUES(tb_user_id),' : ''}
         tb_bank_account_id = VALUES(tb_bank_account_id), dt_record = VALUES(dt_record),
         tb_bank_historic_id = VALUES(tb_bank_historic_id),
         credit_value = VALUES(credit_value), debit_value = VALUES(debit_value),
         manual_history = VALUES(manual_history), kind = VALUES(kind),
         settled_code = VALUES(settled_code), future = VALUES(future),
         dt_original = VALUES(dt_original), doc_reference = VALUES(doc_reference),
         conferred = VALUES(conferred),
         tb_payment_types_id = IF(VALUES(tb_payment_types_id) > 0, VALUES(tb_payment_types_id), tb_payment_types_id),
         tb_financial_plans_id_cre = VALUES(tb_financial_plans_id_cre),
         tb_financial_plans_id_deb = VALUES(tb_financial_plans_id_deb),
         deleted = VALUES(deleted), updated_at = NOW()`,
      // bank_account/bank_historic são NOT NULL no DDL — 0 = sentinela
      // "sem conta/sem histórico" (movimento de caixa), padrão das colunas
      // de referência sem FK (PADROES_BANCO/migration 012).
      [s.id, institutionId, s.terminal, s.bankAccountId ?? 0, s.dtRecord,
       s.bankHistoricId ?? 0, s.creditValue ?? 0, s.debitValue ?? 0,
       s.manualHistory ?? null, s.kind ?? null, s.settledCode ?? 0, userId,
       s.future, s.dtOriginal ?? null, s.docReference ?? null, s.conferred,
       paymentTypeId, s.financialPlansIdCre ?? 0, s.financialPlansIdDeb ?? 0,
       s.deleted]
    )

    await conn.commit()
    res.json(syncSuccess(s.id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /financial-statement/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
