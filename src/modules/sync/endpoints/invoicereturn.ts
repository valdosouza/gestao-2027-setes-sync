import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Retornos de NF-e/NFS-e (Onda 6 — D8 "depois das 25"): o desktop autoriza/
 * rejeita/cancela o documento fiscal na SEFAZ/prefeitura e sincroniza o
 * RETORNO. Três alvos dedicados que JÁ existem no modelo:
 *   modelo 55  → tb_invoice_return_55
 *   modelo 65  → tb_invoice_return_65 (NFC-e — atributos de emissão próprios)
 *   NFS-e      → tb_invoice_return_service (a TInvoiceReturnServiceSendWeb
 *                estava COMENTADA no Delphi — bug C3; endpoint nasce aqui)
 * `fileName` referencia o XML gravado pelo /filexml (D9/D20 — disco por
 * CNPJ). Id local ✅ (MAPA). Contrato: CONTRATOS_SYNC.md.
 */
// Tipos alinhados ao DDL real: status_code/nr_rps/nr_lot são INT NOT NULL
// (default 0 = "sem valor"); number varchar(10); motive varchar(60).
const base = {
  id:         z.number().int().positive(),
  terminal:   z.number().int().min(0),
  number:     z.string().trim().max(10),
  statusCode: z.number().int().optional().default(0),
  fileName:   z.string().trim().max(255).nullable().optional(),
  motive:     z.string().trim().max(60).nullable().optional(),
  deleted:    z.enum(['S', 'N']).optional().default('N'),
}

const return55Body = z.object({
  ...base,
  serie: z.string().trim().max(10).nullable().optional(),
})

const return65Body = z.object({
  ...base,
  serie:       z.string().trim().max(10).nullable().optional(),
  nrLot:       z.number().int().optional().default(0),
  synchronous: z.enum(['S', 'N']).optional().default('S'),
  emissiType:  z.string().trim().max(2).nullable().optional(),
  formatType:  z.string().trim().max(2).nullable().optional(),
  presenIndi:  z.string().trim().max(2).nullable().optional(),
})

const returnServiceBody = z.object({
  ...base,
  nrRps:       z.number().int().optional().default(0),
  nrLot:       z.number().int().optional().default(0),
  protocol:    z.string().trim().max(50).nullable().optional(),
  // NFS_COD_VERIF é VARCHAR(100) no Firebird — prefeituras devolvem a
  // própria chave da nota (50+ chars). Migration 024 alargou a coluna.
  codeVerif:   z.string().trim().max(100).nullable().optional(),
  kind:        z.string().trim().max(1).nullable().optional(),
  synchronous: z.enum(['S', 'N']).optional().default('S'),
  // NFS_MOTIVO é VARCHAR(255) no Firebird (rejeições de prefeitura são
  // longas) — sobrepõe o max(60) do base; migration 024 alargou a coluna.
  motive:      z.string().trim().max(255).nullable().optional(),
})

function handle(
  path: string, table: string, schema: z.ZodType<any>,
  columns: Array<[string, string]> // [coluna, campoCamel]
) {
  /* Swagger dos três retornos segue o mesmo shape — documentado por endpoint abaixo. */
  router.post(path, async (req: Request, res: Response) => {
    const conn = await pool.getConnection()
    try {
      const parsed = schema.safeParse(req.body)
      if (!parsed.success) {
        throw new HttpError(400, 'Payload inválido',
          parsed.error.issues.map((i: z.ZodIssue) => ({ field: i.path.join('.'), message: i.message })))
      }
      const d: any = parsed.data
      const { institutionId, schemaName } = req.syncClient!

      await conn.beginTransaction()
      await conn.query(`USE \`${schemaName}\``)

      const cols = ['id', 'tb_institution_id', 'terminal', ...columns.map(c => c[0]), 'deleted']
      const vals = [d.id, institutionId, d.terminal, ...columns.map(c => d[c[1]] ?? null), d.deleted]
      const updates = [...columns.map(c => `\`${c[0]}\` = VALUES(\`${c[0]}\`)`),
        `deleted = VALUES(deleted)`, `updated_at = NOW()`]
      await conn.query(
        `INSERT INTO \`${table}\`
           (${cols.map(c => `\`${c}\``).join(', ')}, created_at, updated_at)
         VALUES (${cols.map(() => '?').join(', ')}, NOW(), NOW())
         ON DUPLICATE KEY UPDATE ${updates.join(', ')}`,
        vals
      )

      await conn.commit()
      res.json(syncSuccess(d.id))
    } catch (err: any) {
      await conn.rollback()
      if (err instanceof HttpError) {
        res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields })
        return
      }
      logger.error(`Erro em ${path}`, { err, client: req.syncClient })
      res.status(500).json(syncError(err.message))
    } finally {
      conn.release()
    }
  })
}

/**
 * @swagger
 * /invoice-return-55/sincronize:
 *   post:
 *     summary: Sincronizar retorno de NF-e modelo 55
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id }" }
 */
handle('/invoice-return-55/sincronize', 'tb_invoice_return_55', return55Body, [
  ['number', 'number'], ['serie', 'serie'], ['status_code', 'statusCode'],
  ['file_name', 'fileName'], ['motive', 'motive'],
])

/**
 * @swagger
 * /invoice-return-65/sincronize:
 *   post:
 *     summary: Sincronizar retorno de NFC-e modelo 65
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id }" }
 */
handle('/invoice-return-65/sincronize', 'tb_invoice_return_65', return65Body, [
  ['number', 'number'], ['serie', 'serie'], ['nr_lot', 'nrLot'],
  ['synchronous', 'synchronous'], ['emissi_type', 'emissiType'],
  ['format_type', 'formatType'], ['presen_indi', 'presenIndi'],
  ['status_code', 'statusCode'], ['file_name', 'fileName'], ['motive', 'motive'],
])

/**
 * @swagger
 * /invoice-return-service/sincronize:
 *   post:
 *     summary: Sincronizar retorno de NFS-e (era o bug C3 do Delphi)
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id }" }
 */
handle('/invoice-return-service/sincronize', 'tb_invoice_return_service', returnServiceBody, [
  ['number', 'number'], ['nr_rps', 'nrRps'], ['nr_lot', 'nrLot'],
  ['protocol', 'protocol'], ['code_verif', 'codeVerif'], ['kind', 'kind'],
  ['synchronous', 'synchronous'], ['status_code', 'statusCode'],
  ['file_name', 'fileName'], ['motive', 'motive'],
])

export default router
