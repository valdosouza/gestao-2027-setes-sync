import { Router, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Arquivos XML — Onda 6 (decisões D9/D20): o que o Firebird gravava no
 * banco passa a viver em DISCO no servidor, indexado pelo CNPJ do CLIENTE:
 *   SYNC_FILES_ROOT/<cnpj>/<ano>/<mes>/<fileName>
 * O CNPJ vem da PRÓPRIA institution (resolvida pela API key — D12); ano/mês
 * vêm de dtReference (data de emissão do documento). Conteúdo em Base64
 * (fim do bug C7 — o Delphi enviava só metadados). O nome do arquivo é o
 * elo com tb_invoice_return_*.file_name. Contrato: CONTRATOS_SYNC.md.
 */
const fileBody = z.object({
  fileName:    z.string().trim().min(1).max(100)
                .regex(/^[A-Za-z0-9._-]+$/, 'fileName inválido (sem caminhos/caracteres especiais)'),
  contentBase64: z.string().min(1),
  dtReference:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})

async function institutionCnpj(institutionId: number): Promise<string> {
  // institution herda da entity (PK compartilhada) — o CNPJ está na tb_company
  const [rows] = await pool.query<any[]>(
    `SELECT cnpj FROM setes_central.tb_company WHERE id = ? AND deleted = 'N' LIMIT 1`,
    [institutionId]
  )
  return rows.length ? String(rows[0].cnpj) : ''
}

/**
 * @swagger
 * /filexml/sincronize:
 *   post:
 *     summary: Receber arquivo XML (disco, indexado por CNPJ — D9/D20)
 *     description: >-
 *       Grava em SYNC_FILES_ROOT/&lt;cnpj&gt;/&lt;ano&gt;/&lt;mes&gt;/&lt;fileName&gt;.
 *       CNPJ = da institution da API key; ano/mês = dtReference.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fileName, contentBase64, dtReference]
 *             properties:
 *               fileName: { type: string, example: "35260711222333000181550010001234561000123456-nfe.xml" }
 *               contentBase64: { type: string, example: "PD94bWwgdmVyc2lvbj0iMS4wIj8+..." }
 *               dtReference: { type: string, example: "2026-07-19" }
 *     responses:
 *       200: { description: "{ ok, id: 0 }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       500: { description: Erro ao gravar }
 */
router.post('/filexml/sincronize', async (req: Request, res: Response) => {
  try {
    const parsed = fileBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { fileName, contentBase64, dtReference } = parsed.data
    const { institutionId, establishmentCode } = req.syncClient!

    const cnpj = (await institutionCnpj(institutionId)) || establishmentCode
    const [year, month] = dtReference.split('-')

    const root = process.env.SYNC_FILES_ROOT ?? './storage/xml'
    const folder = path.join(root, cnpj, year, month)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, fileName), Buffer.from(contentBase64, 'base64'))

    logger.info('XML gravado', { cnpj, year, month, fileName })
    res.json(syncSuccess(0))
  } catch (err: any) {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields })
      return
    }
    logger.error('Erro em /filexml/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  }
})

export default router
