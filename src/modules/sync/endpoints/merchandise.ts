import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureCatalogItem, upsertCatalogLink } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Produto — ID LOCAL ✅ (MAPA_INDEXACAO #5): PRO_CODIGO do Firebird É o id
 * nas TRÊS tabelas do schema do cliente (tb_product / tb_merchandise /
 * tb_stock — PK por institution). Marca, embalagem e medida chegam por
 * DESCRIÇÃO e são resolvidas no catálogo CENTRAL (D5/D17: ensureCatalogItem)
 * + vínculo tb_institution_has_* no schema do cliente; descrição ausente cai
 * no legado documentado: 'NÃO INFORMADA' (marca) e 'UND' (embalagem/medida).
 * Categoria vem por id local — se ainda não sincronizada, 409
 * CATEGORY_NOT_SYNCED (o Sincronizador reenvia no próximo ciclo).
 * SALDO NÃO PASSA AQUI: quantity/minimum pertencem ao /stock-balance —
 * o INSERT abre com 0 e o UPDATE não toca nesses campos.
 * deleted='S' = soft delete nas três linhas (D2). Contrato JSON limpo
 * camelCase em blocos {product, merchandise, stock} espelhando as tabelas
 * (D15 — o Delphi se adapta). Contrato: CONTRATOS_SYNC.md.
 */
const productBlock = z.object({
  description:      z.string().trim().min(1).max(100),
  categoryId:       z.number().int().positive(),
  identifier:       z.string().trim().max(50).optional(),
  financialPlansId: z.number().int().positive().nullish(),
  promotion:        z.enum(['S', 'N']).optional().default('N'),
  highlights:       z.enum(['S', 'N']).optional().default('N'),
  active:           z.enum(['S', 'N']).optional().default('S'),
  published:        z.enum(['S', 'N']).optional().default('N'),
  note:             z.string().optional(),
})

const merchandiseBlock = z.object({
  nameBrand:         z.string().trim().max(100).optional(),
  internalId:        z.string().trim().max(45).optional(),
  ncm:               z.string().trim().max(8).optional(),
  cest:              z.string().trim().max(7).optional(),
  kindTributary:     z.string().trim().max(1).optional(),
  source:            z.string().trim().max(1).optional(),
  kind:              z.string().trim().max(45).optional(),
  print:             z.enum(['S', 'N']).optional(),
  controlSeries:     z.enum(['S', 'N']).optional(),
  exclusiveDealer:   z.enum(['S', 'N']).optional(),
  application:       z.string().optional(),
  composition:       z.enum(['S', 'N']).optional(),
  manufSignIndScale: z.enum(['S', 'N']).optional().default('S'),
})

const stockBlock = z.object({
  namePackage:      z.string().trim().max(100).optional(),
  nameMeasure:      z.string().trim().max(100).optional(),
  codebar:          z.string().trim().max(20).optional(),
  st:               z.enum(['S', 'N']).optional().default('N'),
  divisor:          z.number().int().positive().nullish(),
  location:         z.string().trim().max(100).optional(),
  weight:           z.number().nullish(),
  width:            z.number().nullish(),
  length:           z.number().nullish(),
  height:           z.number().nullish(),
  costManufactures: z.number().nullish(),
  actualCost:       z.number().nullish(),
  costPrice:        z.number().nullish(),
  negative:         z.enum(['S', 'N']).optional(),
  outline:          z.enum(['S', 'N']).optional(),
})

const merchandiseBody = z.object({
  id:          z.number().int().positive(),
  deleted:     z.enum(['S', 'N']).optional().default('N'),
  product:     productBlock,
  merchandise: merchandiseBlock.optional().default({}),
  stock:       stockBlock.optional().default({}),
})

/**
 * @swagger
 * /merchandise/sincronize:
 *   post:
 *     summary: Sincronizar Produto (tb_product + tb_merchandise + tb_stock, id local)
 *     description: >-
 *       Upsert nas três tabelas do schema do cliente com id = PRO_CODIGO do
 *       Firebird (PK id+institution). Marca/embalagem/medida chegam por
 *       descrição (nameBrand/namePackage/nameMeasure) e são resolvidas no
 *       catálogo central + vínculo tb_institution_has_*; ausentes viram
 *       'NÃO INFORMADA' (marca) e 'UND' (embalagem/medida). Categoria por id
 *       local — inexistente = 409 CATEGORY_NOT_SYNCED (reenvio no próximo
 *       ciclo). quantity/minimum do estoque NÃO passam aqui (vêm do
 *       /stock-balance). deleted='S' = soft delete nas três linhas.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, product]
 *             properties:
 *               id: { type: integer, example: 501, description: PRO_CODIGO do Firebird }
 *               deleted: { type: string, enum: [S, N] }
 *               product:
 *                 type: object
 *                 required: [description, categoryId]
 *                 properties:
 *                   description: { type: string, example: "REFRIGERANTE COLA 2L" }
 *                   categoryId: { type: integer, example: 12 }
 *                   identifier: { type: string, example: "7891234" }
 *                   financialPlansId: { type: integer, nullable: true }
 *                   promotion: { type: string, enum: [S, N] }
 *                   highlights: { type: string, enum: [S, N] }
 *                   active: { type: string, enum: [S, N] }
 *                   published: { type: string, enum: [S, N] }
 *                   note: { type: string }
 *               merchandise:
 *                 type: object
 *                 properties:
 *                   nameBrand: { type: string, example: "COCA-COLA" }
 *                   internalId: { type: string }
 *                   ncm: { type: string, example: "22021000" }
 *                   cest: { type: string, example: "0300700" }
 *                   kindTributary: { type: string, example: "T" }
 *                   source: { type: string, example: "0" }
 *                   kind: { type: string, example: "00" }
 *                   print: { type: string, enum: [S, N] }
 *                   controlSeries: { type: string, enum: [S, N] }
 *                   exclusiveDealer: { type: string, enum: [S, N] }
 *                   application: { type: string }
 *                   composition: { type: string, enum: [S, N] }
 *                   manufSignIndScale: { type: string, enum: [S, N] }
 *               stock:
 *                 type: object
 *                 properties:
 *                   namePackage: { type: string, example: "GARRAFA" }
 *                   nameMeasure: { type: string, example: "UND" }
 *                   codebar: { type: string, example: "7894900011517" }
 *                   st: { type: string, enum: [S, N] }
 *                   divisor: { type: integer, nullable: true }
 *                   location: { type: string }
 *                   weight: { type: number }
 *                   width: { type: number }
 *                   length: { type: number }
 *                   height: { type: number }
 *                   costManufactures: { type: number }
 *                   actualCost: { type: number }
 *                   costPrice: { type: number }
 *                   negative: { type: string, enum: [S, N] }
 *                   outline: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id } — id = PRO_CODIGO" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Categoria ainda não sincronizada — reenviar depois }
 *       500: { description: Erro ao processar }
 */
router.post('/merchandise/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = merchandiseBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, deleted, product, merchandise, stock } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()

    // Catálogos centrais por DESCRIÇÃO (D5/D17) — fallback legado documentado
    const brandDesc   = merchandise.nameBrand?.trim()  || 'NÃO INFORMADA'
    const packageDesc = stock.namePackage?.trim()      || 'UND'
    const measureDesc = stock.nameMeasure?.trim()      || 'UND'
    const { id: brandId }   = await ensureCatalogItem(conn, 'tb_brand',   brandDesc)
    const { id: packageId } = await ensureCatalogItem(conn, 'tb_package', packageDesc)
    const { id: measureId } = await ensureCatalogItem(conn, 'tb_measure', measureDesc)

    await conn.query(`USE \`${schemaName}\``)

    // Vínculos vivos no schema do cliente (sem attrs: não mexe no active do vínculo)
    await upsertCatalogLink(conn, 'tb_institution_has_brand',   'tb_brand_id',   institutionId, brandId)
    await upsertCatalogLink(conn, 'tb_institution_has_package', 'tb_package_id', institutionId, packageId)
    await upsertCatalogLink(conn, 'tb_institution_has_measure', 'tb_measure_id', institutionId, measureId)

    // Categoria por id local — precisa já ter sido sincronizada
    const [cats] = await conn.query<any[]>(
      `SELECT id FROM tb_category
       WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' LIMIT 1`,
      [product.categoryId, institutionId]
    )
    if (!cats.length) {
      throw new HttpError(409, `Categoria ${product.categoryId} ainda não sincronizada`,
        [{ field: 'product.categoryId', message: 'sincronize a categoria antes — reenvio no próximo ciclo' }],
        'CATEGORY_NOT_SYNCED')
    }

    // ── tb_product (PK id + tb_institution_id) ──────────────────────────
    const [exProduct] = await conn.query<any[]>(
      `SELECT id FROM tb_product WHERE id = ? AND tb_institution_id = ? LIMIT 1 FOR UPDATE`,
      [id, institutionId]
    )
    const productValues = [
      product.identifier ?? '0', product.description, product.categoryId,
      product.financialPlansId ?? null, product.promotion, product.highlights,
      product.active, product.published, product.note ?? null, deleted,
    ]
    if (exProduct.length) {
      await conn.query(
        `UPDATE tb_product
         SET identifier = ?, description = ?, tb_category_id = ?, tb_financial_plans_id = ?,
             promotion = ?, highlights = ?, active = ?, published = ?, note = ?, deleted = ?,
             updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [...productValues, id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_product
           (id, tb_institution_id, identifier, description, tb_category_id, tb_financial_plans_id,
            promotion, highlights, active, published, note, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, institutionId, ...productValues]
      )
    }

    // ── tb_merchandise (PK id + tb_institution_id, FK → tb_product) ─────
    const [exMerch] = await conn.query<any[]>(
      `SELECT id FROM tb_merchandise WHERE id = ? AND tb_institution_id = ? LIMIT 1 FOR UPDATE`,
      [id, institutionId]
    )
    const merchValues = [
      merchandise.internalId ?? null, merchandise.ncm ?? null, merchandise.cest ?? null,
      merchandise.kindTributary ?? null, merchandise.source ?? null, merchandise.kind ?? null,
      brandId, merchandise.print ?? null, merchandise.controlSeries ?? null,
      merchandise.exclusiveDealer ?? null, merchandise.application ?? null,
      merchandise.composition ?? null, merchandise.manufSignIndScale, deleted,
    ]
    if (exMerch.length) {
      await conn.query(
        `UPDATE tb_merchandise
         SET id_internal = ?, ncm = ?, cest = ?, kind_tributary = ?, source = ?, kind = ?,
             tb_brand_id = ?, print = ?, controlseries = ?, exclusive_dealer = ?,
             application = ?, composition = ?, manuf_sign_ind_scale = ?, deleted = ?,
             updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [...merchValues, id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_merchandise
           (id, tb_institution_id, id_internal, ncm, cest, kind_tributary, source, kind,
            tb_brand_id, print, controlseries, exclusive_dealer, application, composition,
            manuf_sign_ind_scale, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, institutionId, ...merchValues]
      )
    }

    // ── tb_stock (PK tb_institution_id + tb_merchandise_id) ─────────────
    // Saldo NÃO vem aqui: quantity/minimum são do /stock-balance —
    // INSERT abre com 0 e o UPDATE preserva o que está gravado.
    const [exStock] = await conn.query<any[]>(
      `SELECT tb_merchandise_id FROM tb_stock
       WHERE tb_institution_id = ? AND tb_merchandise_id = ? LIMIT 1 FOR UPDATE`,
      [institutionId, id]
    )
    const stockValues = [
      packageId, measureId, stock.codebar ?? null, stock.st,
      stock.divisor ?? null, stock.location ?? null,
      stock.weight ?? null, stock.width ?? null, stock.length ?? null, stock.height ?? null,
      stock.costManufactures ?? null, stock.actualCost ?? null, stock.costPrice ?? null,
      stock.negative ?? null, stock.outline ?? null, deleted,
    ]
    if (exStock.length) {
      await conn.query(
        `UPDATE tb_stock
         SET tb_package_id = ?, tb_measure_id = ?, codebar = ?, st = ?, divisor = ?, location = ?,
             weight = ?, width = ?, \`length\` = ?, height = ?,
             cost_manufactures = ?, actual_cost = ?, cost_price = ?,
             negative = ?, outline = ?, deleted = ?, updated_at = NOW()
         WHERE tb_institution_id = ? AND tb_merchandise_id = ?`,
        [...stockValues, institutionId, id]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_stock
           (tb_institution_id, tb_merchandise_id, tb_package_id, tb_measure_id, codebar, st,
            divisor, location, weight, width, \`length\`, height,
            cost_manufactures, actual_cost, cost_price, negative, outline, deleted,
            quantity, minimum, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW(), NOW())`,
        [institutionId, id, ...stockValues]
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
    logger.error('Erro em /merchandise/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
