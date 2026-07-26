import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Conta Bancária — id local ✅ (CTB_CODIGO, MAPA_INDEXACAO). Banco chega
 * pelo NÚMERO FEBRABAN (bankNumber) e é resolvido em setes_central.tb_bank
 * (DP2 do Software House) — número desconhecido = 409 BANK_NOT_FOUND
 * (catálogo FEBRABAN é seed da central; incluir o banco e reenviar).
 * Este endpoint substitui o fluxo do bug C1 do Delphi (payload vazio —
 * o data object novo envia todos os campos). Contrato: CONTRATOS_SYNC.md.
 */
const bankAccountBody = z.object({
  id:         z.number().int().positive(),
  bankNumber: z.string().trim().min(1).max(3),
  dtOpening:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  agency:     z.string().max(8).nullable().optional(),
  agencyDv:   z.string().max(2).nullable().optional(),
  number:     z.string().max(10).nullable().optional(),
  numberDv:   z.string().max(2).nullable().optional(),
  phone:      z.string().max(10).regex(/^\d*$/).nullable().optional(),
  manager:    z.string().max(25).nullable().optional(),
  limitValue: z.number().nullable().optional(),
  dtContract: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deleted:    z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /bank-account/sincronize:
 *   post:
 *     summary: Sincronizar Conta Bancária (id local + banco FEBRABAN)
 *     description: >-
 *       Upsert em tb_bank_account com id = CTB_CODIGO. bankNumber (código
 *       FEBRABAN) resolvido em setes_central.tb_bank — desconhecido = 409.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, bankNumber]
 *             properties:
 *               id: { type: integer, example: 3 }
 *               bankNumber: { type: string, example: "001" }
 *               dtOpening: { type: string, example: "2020-01-15" }
 *               agency: { type: string, example: "1234" }
 *               agencyDv: { type: string, example: "5" }
 *               number: { type: string, example: "98765" }
 *               numberDv: { type: string, example: "0" }
 *               phone: { type: string, example: "6233330000" }
 *               manager: { type: string, example: "FULANO" }
 *               limitValue: { type: number, example: 50000 }
 *               dtContract: { type: string, example: "2025-01-01" }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Banco FEBRABAN não encontrado na central }
 *       500: { description: Erro ao processar }
 */
router.post('/bank-account/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = bankAccountBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const b = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    const [banks] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_bank
       WHERE number = ? AND deleted = 'N' LIMIT 1`,
      [b.bankNumber.padStart(3, '0')]
    )
    if (!banks.length) {
      throw new HttpError(409, `Banco FEBRABAN ${b.bankNumber} não encontrado na central`,
        [{ field: 'bankNumber', message: 'inclua o banco no catálogo central (seed sql/17) e reenvie' }],
        'BANK_NOT_FOUND')
    }
    const bankId = Number(banks[0].id)

    await conn.query(`USE \`${schemaName}\``)
    await conn.query(
      `INSERT INTO tb_bank_account
         (id, tb_institution_id, tb_bank_id, dt_opening, agency, agency_dv,
          number, number_dv, phone, manager, limit_value, dt_contract,
          deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         tb_bank_id = VALUES(tb_bank_id), dt_opening = VALUES(dt_opening),
         agency = VALUES(agency), agency_dv = VALUES(agency_dv),
         number = VALUES(number), number_dv = VALUES(number_dv),
         phone = VALUES(phone), manager = VALUES(manager),
         limit_value = VALUES(limit_value), dt_contract = VALUES(dt_contract),
         deleted = VALUES(deleted), updated_at = NOW()`,
      [b.id, institutionId, bankId, b.dtOpening ?? null, b.agency ?? null,
       b.agencyDv ?? null, b.number ?? null, b.numberDv ?? null, b.phone ?? null,
       b.manager ?? null, b.limitValue ?? null, b.dtContract ?? null, b.deleted]
    )

    await conn.commit()
    res.json(syncSuccess(b.id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /bank-account/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
