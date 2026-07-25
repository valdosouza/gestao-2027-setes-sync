import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import {
  syncEntityBody, saveSyncEntity, stripDocumentMasks, findEntityIdByDocument,
} from '../sync.entity'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Resolve documento → entity.id E confirma o papel no schema do cliente
 * (decisão 4 da revisão de entidades): a entity existir na central não
 * basta — sem a linha do papel o vínculo seria para um não-vendedor/
 * não-transportadora. Nome qualificado porque a conexão ainda não deu USE.
 */
async function findRoleIdByDocument(
  conn: any, schemaName: string, roleTable: 'tb_salesman' | 'tb_carrier',
  institutionId: number, document: string
): Promise<number | null> {
  const entityId = await findEntityIdByDocument(conn, document)
  if (entityId === null) return null
  const [rows] = await conn.query(
    `SELECT 1 FROM \`${schemaName}\`.\`${roleTable}\`
     WHERE id = ? AND tb_institution_id = ? AND deleted = 'N'`,
    [entityId, institutionId]
  )
  return (rows as any[]).length ? entityId : null
}

/**
 * Cliente — 1º papel de entidade da revisão (Onda 4). Reindexação D3/D4:
 * a cadeia (entity/person|company|no_doc/address/phone/mailing) vai para
 * setes_central pelo MOTOR (sync.entity.ts); aqui fica só o PAPEL
 * tb_customer no schema do cliente, com id = entity.id (D13).
 * Vendedor/transportador chegam por DOCUMENTO (nunca código local — D3);
 * não sincronizados ainda → 409 de reenvio. Campos fiscais do cliente
 * (consumer/by_pass_st/ISS/envio de NF-e) vão em tb_entity_tax (Rodada 4
 * da Fase 3). Contrato: CONTRATOS_SYNC.md.
 */
const customerBody = z.object({
  salesmanDocument:       z.string().trim().min(11).max(18).optional(),
  carrierDocument:        z.string().trim().min(11).max(18).optional(),
  creditStatus:           z.string().max(1).nullable().optional(),
  creditValue:            z.number().nullable().optional(),
  paymentTypeDescription: z.string().trim().min(1).max(45).optional(),
  multiplier:             z.number().optional().default(1),
  active:                 z.enum(['S', 'N']).optional().default('S'),
})

const entityTaxBody = z.object({
  consumer:               z.enum(['S', 'N']).optional(),
  taxRegime:              z.string().max(100).nullable().optional(),
  byPassSt:               z.enum(['S', 'N']).optional(),
  indIeDest:              z.string().max(1).nullable().optional(),
  issExigibilidade:       z.string().max(2).nullable().optional(),
  issProcessNr:           z.string().max(25).nullable().optional(),
  issRetido:              z.enum(['S', 'N']).optional(),
  issIndIncFiscal:        z.enum(['S', 'N']).optional(),
  autoSendInvoice:        z.enum(['S', 'N']).optional(),
  autoSendInvoiceJustXml: z.enum(['S', 'N']).optional(),
})

/**
 * @swagger
 * /customer/sincronize:
 *   post:
 *     summary: Sincronizar Cliente (cadeia central + papel no schema)
 *     description: >-
 *       Bloco entity padrão (CONTRATOS_SYNC.md) reindexado por CPF/CNPJ ou
 *       externalCode (UUID) + bloco customer (papel) + bloco entityTax
 *       (fiscal por relação comercial). Vendedor/transportador por
 *       DOCUMENTO — 409 SALESMAN_NOT_SYNCED/CARRIER_NOT_SYNCED se ainda não
 *       sincronizados. Devolve externalCode quando personType='N'.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     responses:
 *       200: { description: "{ ok, id, externalCode?, clearExternalCode? } — id = entity.id" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       404: { description: externalCode desconhecido }
 *       409: { description: Referência ainda não sincronizada — reenviar }
 *       500: { description: Erro ao processar }
 */
router.post('/customer/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const entityParsed = syncEntityBody.safeParse(stripDocumentMasks(req.body))
    if (!entityParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco entity)',
        entityParsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const custParsed = customerBody.safeParse(req.body.customer ?? {})
    if (!custParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco customer)',
        custParsed.error.issues.map(i => ({ field: `customer.${i.path.join('.')}`, message: i.message })))
    }
    const taxParsed = entityTaxBody.safeParse(req.body.entityTax ?? {})
    if (!taxParsed.success) {
      throw new HttpError(400, 'Payload inválido (bloco entityTax)',
        taxParsed.error.issues.map(i => ({ field: `entityTax.${i.path.join('.')}`, message: i.message })))
    }
    const cust = custParsed.data
    const tax  = taxParsed.data
    const hasTax = req.body.entityTax !== undefined
    const deleted: 'S' | 'N' = req.body.deleted === 'S' ? 'S' : 'N'
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // 1. Cadeia na CENTRAL (motor de reindexação + graduação do sem-doc)
    const { entityId, externalCode, clearExternalCode } =
      await saveSyncEntity(conn, entityParsed.data, { origin: 'customer', institutionId })

    // 2. Referências por DOCUMENTO (D3) — decisão 4 da revisão de entidades
    //    (2026-07-25): o 409 verifica o PAPEL no schema do cliente, não só a
    //    existência da entity (o mesmo CPF pode existir só como cliente).
    let salesmanId: number | null = null
    if (cust.salesmanDocument) {
      salesmanId = await findRoleIdByDocument(conn, schemaName, 'tb_salesman',
        institutionId, cust.salesmanDocument)
      if (salesmanId === null) {
        throw new HttpError(409, `Vendedor ${cust.salesmanDocument} ainda não sincronizado`,
          [{ field: 'customer.salesmanDocument', message: 'sincronize o vendedor antes — reenvio no próximo ciclo' }],
          'SALESMAN_NOT_SYNCED')
      }
    }
    let carrierId: number | null = null
    if (cust.carrierDocument) {
      carrierId = await findRoleIdByDocument(conn, schemaName, 'tb_carrier',
        institutionId, cust.carrierDocument)
      if (carrierId === null) {
        throw new HttpError(409, `Transportador ${cust.carrierDocument} ainda não sincronizado`,
          [{ field: 'customer.carrierDocument', message: 'sincronize o transportador antes — reenvio no próximo ciclo' }],
          'CARRIER_NOT_SYNCED')
      }
    }

    // 3. Forma de pagamento da carteira por DESCRIÇÃO (catálogo central)
    let paymentTypeId = 0
    if (cust.paymentTypeDescription) {
      const pt = await ensureCatalogItem(conn, 'tb_payment_types', cust.paymentTypeDescription)
      paymentTypeId = pt.id
    }

    // 4. Papel no schema do cliente (id = entity.id — D13)
    await conn.query(`USE \`${schemaName}\``)
    if (cust.paymentTypeDescription) {
      await upsertCatalogLink(conn, 'tb_institution_has_payment_types', 'tb_payment_types_id',
        institutionId, paymentTypeId)
    }
    await conn.query(
      `INSERT INTO tb_customer
         (id, tb_institution_id, tb_salesman_id, tb_carrier_id, credit_status,
          credit_value, tb_payment_types_id, multiplier, active, deleted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         tb_salesman_id = VALUES(tb_salesman_id), tb_carrier_id = VALUES(tb_carrier_id),
         credit_status = VALUES(credit_status), credit_value = VALUES(credit_value),
         tb_payment_types_id = IF(VALUES(tb_payment_types_id) > 0, VALUES(tb_payment_types_id), tb_payment_types_id),
         multiplier = VALUES(multiplier), active = VALUES(active),
         deleted = VALUES(deleted), updated_at = NOW()`,
      [entityId, institutionId, salesmanId, carrierId, cust.creditStatus ?? null,
       cust.creditValue ?? null, paymentTypeId, cust.multiplier, cust.active, deleted]
    )

    // 5. Fiscal por relação comercial (tb_entity_tax) — só se o bloco veio
    if (hasTax) {
      await conn.query(
        `INSERT INTO tb_entity_tax
           (id, tb_institution_id, consumer, tax_regime, by_pass_st, ind_ie_dest,
            iss_exigibilidade, iss_process_nr, iss_retido, iss_ind_inc_fiscal,
            auto_send_invoice, auto_send_invoice_just_xml, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           consumer = VALUES(consumer), tax_regime = VALUES(tax_regime),
           by_pass_st = VALUES(by_pass_st), ind_ie_dest = VALUES(ind_ie_dest),
           iss_exigibilidade = VALUES(iss_exigibilidade), iss_process_nr = VALUES(iss_process_nr),
           iss_retido = VALUES(iss_retido), iss_ind_inc_fiscal = VALUES(iss_ind_inc_fiscal),
           auto_send_invoice = VALUES(auto_send_invoice),
           auto_send_invoice_just_xml = VALUES(auto_send_invoice_just_xml),
           deleted = 'N', updated_at = NOW()`,
        [entityId, institutionId, tax.consumer ?? 'N', tax.taxRegime ?? null,
         tax.byPassSt ?? 'N', tax.indIeDest ?? null, tax.issExigibilidade ?? null,
         tax.issProcessNr ?? null, tax.issRetido ?? 'N', tax.issIndIncFiscal ?? 'N',
         tax.autoSendInvoice ?? 'N', tax.autoSendInvoiceJustXml ?? 'N']
      )
    }

    await conn.commit()
    res.json(syncSuccess(entityId, externalCode, clearExternalCode))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /customer/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
