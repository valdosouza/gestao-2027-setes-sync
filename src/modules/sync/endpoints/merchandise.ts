import { Router, Request, Response } from 'express'
import { PoolConnection } from 'mysql2/promise'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { ensureAndLinkCatalogItem, CatalogItemInput } from '../sync.catalog'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import { snFlag, legacyChar } from '@shared/validation'

const router = Router()

/**
 * Produto — ID LOCAL ✅ (MAPA_INDEXACAO #5): PRO_CODIGO do Firebird É o id
 * nas TRÊS tabelas do schema do cliente (tb_product / tb_merchandise /
 * tb_stock — PK por institution). Marca e embalagem chegam por DESCRIÇÃO e
 * a medida pela ABREVIAÇÃO (D-SY10 = D-PR39, Valdo 2026-10-18 — a mesma chave
 * do setes-api: `stock.measureAbbreviation`; executável antigo que só manda
 * `stock.nameMeasure` resolve pela descrição, com aviso no log). Resolvidas no
 * catálogo CENTRAL + vínculo tb_institution_has_* (ensureAndLinkCatalogItem,
 * trava nomeada por catálogo, transação PRÓPRIA e ANTES da transação do
 * produto — a trava é global, de todos os clientes, e não pode ficar presa
 * durante a gravação do produto). Ausentes caem no legado documentado:
 * marca 'NÃO INFORMADA', embalagem 'UND' (descrição) e medida 'UND'
 * (ABREVIAÇÃO — antes era descrição e criava uma 2ª linha "UND" sem
 * abreviação ao lado da "UNIDADE"/UND).
 * Categoria vem por id local — se ainda não sincronizada, 409
 * CATEGORY_NOT_SYNCED (o Sincronizador reenvia no próximo ciclo).
 * SALDO NÃO PASSA AQUI: quantity/minimum pertencem ao /stock-balance —
 * o INSERT abre com 0 e o UPDATE não toca nesses campos.
 * NATUREZA (D2 — prompt_notas_mercadoria_servico.md, 2026-07-26): este
 * endpoint só aceita mercadoria — product.kind 'P'/'M' (fallback de
 * transição: merchandise.kind legado); 'S' ou desconhecido = 422
 * KIND_NOT_ALLOWED (serviço usa o /service/sincronize; 'A' aposentado).
 * O kind é gravado em tb_product.kind.
 * deleted='S' = soft delete nas três linhas (D2). Contrato JSON limpo
 * camelCase em blocos {product, merchandise, stock} espelhando as tabelas
 * (D15 — o Delphi se adapta). Contrato: CONTRATOS_SYNC.md.
 */
const productBlock = z.object({
  // PRO_TIPO — '' = ausente (cai no fallback da rota; default final 'P')
  kind:             legacyChar(),
  description:      z.string().trim().min(1).max(100),
  categoryId:       z.number().int().positive(),
  identifier:       z.string().trim().max(50).optional(),
  financialPlansId: z.number().int().positive().nullish(),
  promotion:        snFlag('N'),
  highlights:       snFlag('N'),
  active:           snFlag('S'),
  published:        snFlag('N'),
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
  print:             snFlag(),
  controlSeries:     snFlag(),
  exclusiveDealer:   snFlag(),
  application:       z.string().optional(),
  // PRO_COMPOSICAO espelhado COMO ESTÁ ('1'/'2'/'3'/'5' no legado — decisão
  // Valdo 2026-08-01; snFlag S/N barrava o catálogo inteiro, 8.588 itens)
  composition:       legacyChar(),
  // INDESCALA do legado (D-SY5, Valdo 2026-10-17): S/N como está; vazio ou
  // ausente = NULL ("não informado" — o legado omite a tag indEscala da NF-e).
  // Antes o default 'S' trocava o "não informado" por "relevante".
  manufSignIndScale: snFlag(),
})

const stockBlock = z.object({
  namePackage:      z.string().trim().max(100).optional(),
  // D-SY10: CHAVE da medida (MED_ABREVIATURA, até 5 no legado). Ausente/vazia
  // = executável antigo → resolve por nameMeasure (descrição), com aviso.
  measureAbbreviation: z.string().trim().max(5).optional(),
  // descrição da medida: atributo da CRIAÇÃO quando vem a abreviação
  nameMeasure:      z.string().trim().max(100).optional(),
  codebar:          z.string().trim().max(20).optional(),
  st:               snFlag('N'),
  // PRO_DIVISOR espelhado COMO ESTÁ — 0 é valor legítimo do legado
  // (decisão Valdo 2026-08-01; positive() barrava 840 itens)
  divisor:          z.number().int().nonnegative().nullish(),
  location:         z.string().trim().max(100).optional(),
  weight:           z.number().nullish(),
  width:            z.number().nullish(),
  length:           z.number().nullish(),
  height:           z.number().nullish(),
  costManufactures: z.number().nullish(),
  actualCost:       z.number().nullish(),
  costPrice:        z.number().nullish(),
  negative:         snFlag(),
  outline:          snFlag(),
})

export const merchandiseBody = z.object({
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
 *       Firebird (PK id+institution). Marca/embalagem chegam por descrição
 *       (nameBrand/namePackage) e a medida pela ABREVIAÇÃO
 *       (stock.measureAbbreviation — D-SY10; sem ela, nameMeasure como
 *       descrição para executáveis antigos), resolvidas no catálogo central
 *       (trava nomeada por catálogo, a mesma do setes-api) + vínculo
 *       tb_institution_has_*; ausentes viram 'NÃO INFORMADA' (marca),
 *       'UND' (embalagem, descrição) e 'UND' (medida, abreviação). Categoria por id
 *       local — inexistente = 409 CATEGORY_NOT_SYNCED (reenvio no próximo
 *       ciclo). quantity/minimum do estoque NÃO passam aqui (vêm do
 *       /stock-balance). deleted='S' = soft delete nas três linhas.
 *       Natureza (D2): product.kind 'P'/'M' (gravado em tb_product.kind);
 *       'S'/'A' = 422 KIND_NOT_ALLOWED (serviço usa /service/sincronize).
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
 *                   kind: { type: string, enum: [P, M], example: "P", description: Natureza (PRO_TIPO) — serviço usa /service }
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
 *                   application: { type: string, description: "PRO_APLICACAO em TEXTO (o Sincronizador decodifica o Base64 do legado — D-SY6)" }
 *                   composition: { type: string, example: "1", description: "PRO_COMPOSICAO como está ('1'…'6')" }
 *                   manufSignIndScale: { type: string, enum: [S, N], description: "INDESCALA; vazio/ausente = NULL (não informado — D-SY5)" }
 *               stock:
 *                 type: object
 *                 properties:
 *                   namePackage: { type: string, example: "GARRAFA" }
 *                   measureAbbreviation: { type: string, maxLength: 5, example: "UND", description: "Chave da medida (MED_ABREVIATURA — D-SY10)" }
 *                   nameMeasure: { type: string, example: "UNIDADE", description: "Descrição da medida — atributo da criação; sem measureAbbreviation (executável antigo) vira a chave" }
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
 *       401: { description: "X-Api-Key inexistente ou ausente (SYNC_KEY_INVALID / SYNC_KEY_MISSING)" }
 *       403: { description: "Chave existente e INATIVA (SYNC_KEY_INACTIVE — D-SY13)" }
 *       409: { description: "CATEGORY_NOT_SYNCED (categoria ainda não sincronizada) ou RESOURCE_BUSY (trava do catálogo central ocupada por mais de 10 s) — reenviar depois" }
 *       422: { description: KIND_NOT_ALLOWED — kind 'S' (usa /service) ou 'A' (aposentado) }
 *       500: { description: Erro ao processar }
 */
/**
 * Entradas do catálogo central a partir do payload — fallbacks do legado.
 * Medida: abreviação = chave (D-SY10); sem ela, a descrição (executável antigo);
 * sem nenhuma, a ABREVIAÇÃO 'UND' (criada, se faltar, como "UNIDADE").
 */
export function merchandiseCatalogInputs(
  merchandise: z.infer<typeof merchandiseBlock>, stock: z.infer<typeof stockBlock>
): { brand: CatalogItemInput; package: CatalogItemInput; measure: CatalogItemInput } {
  const measureAbbr = stock.measureAbbreviation?.trim() ?? ''
  const measureDesc = stock.nameMeasure?.trim() ?? ''
  const measure: CatalogItemInput = measureAbbr !== ''
    ? { abbreviation: measureAbbr, description: measureDesc || measureAbbr }
    : measureDesc !== ''
      ? { description: measureDesc }
      : { abbreviation: 'UND', description: 'UNIDADE' }
  return {
    brand:   { description: merchandise.nameBrand?.trim() || 'NÃO INFORMADA' },
    package: { description: stock.namePackage?.trim()    || 'UND' },
    measure,
  }
}

type Queryable = Pick<PoolConnection, 'query'>

/** 409 CATEGORY_NOT_SYNCED quando a categoria (id local) ainda não chegou. */
async function assertCategorySynced(
  q: Queryable, schemaName: string, institutionId: number, categoryId: number
): Promise<void> {
  const [cats] = await q.query<any[]>(
    `SELECT id FROM \`${schemaName}\`.tb_category
     WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' LIMIT 1`,
    [categoryId, institutionId]
  )
  if (!cats.length) {
    throw new HttpError(409, `Categoria ${categoryId} ainda não sincronizada`,
      [{ field: 'product.categoryId', message: 'sincronize a categoria antes — reenvio no próximo ciclo' }],
      'CATEGORY_NOT_SYNCED')
  }
}

router.post('/merchandise/sincronize', async (req: Request, res: Response) => {
  let conn: PoolConnection | null = null
  let inTransaction = false
  try {
    const parsed = merchandiseBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, deleted, product, merchandise, stock } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    // Natureza (D2): 'P'/'M' passam; 'S' vai para o /service; 'A' aposentado.
    // Fallback de transição: executáveis antigos mandam o PRO_TIPO só em
    // merchandise.kind — usa-o quando product.kind não veio ('' conta como
    // ausente; PRO_TIPO null → 'P', decisão Valdo 2026-08-01).
    const kind = product.kind || merchandise.kind || 'P'
    if (kind !== 'P' && kind !== 'M') {
      throw new HttpError(422, `kind '${kind}' não é aceito no /merchandise`,
        [{ field: 'product.kind', message: "serviço ('S') usa o /service/sincronize; 'A' está aposentado" }],
        'KIND_NOT_ALLOWED')
    }

    // Falha cedo, SEM efeito colateral: o 409 mais comum (categoria fora de ordem)
    // não cria item central nem vínculo. Leitura simples — a de dentro da transação decide.
    await assertCategorySynced(pool, schemaName, institutionId, product.categoryId)

    // Catálogos centrais (D5/D17 + D-SY10) ANTES da transação do produto: cada um
    // na sua transação curta sob a trava nomeada do catálogo (uma por vez — nunca
    // duas travas nomeadas juntas) + vínculo vivo no schema do cliente (sem attrs:
    // não mexe no active do vínculo). Se a gravação do produto falhar depois, o
    // item central e o vínculo ficam — são dado real do legado e o reenvio os reusa.
    const inputs = merchandiseCatalogInputs(merchandise, stock)
    const { id: brandId }   = await ensureAndLinkCatalogItem('tb_brand',   schemaName, institutionId, inputs.brand)
    const { id: packageId } = await ensureAndLinkCatalogItem('tb_package', schemaName, institutionId, inputs.package)
    const { id: measureId } = await ensureAndLinkCatalogItem('tb_measure', schemaName, institutionId, inputs.measure)

    // só agora a conexão da transação principal (quem chama o catálogo não pode
    // segurar outra conexão do pool — sync.catalog.ts)
    conn = await pool.getConnection()
    await conn.beginTransaction()
    inTransaction = true
    await conn.query(`USE \`${schemaName}\``)

    // Categoria por id local — precisa já ter sido sincronizada (a conferência que VALE)
    await assertCategorySynced(conn, schemaName, institutionId, product.categoryId)

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
         SET kind = ?, identifier = ?, description = ?, tb_category_id = ?, tb_financial_plans_id = ?,
             promotion = ?, highlights = ?, active = ?, published = ?, note = ?, deleted = ?,
             updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [kind, ...productValues, id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_product
           (id, tb_institution_id, kind, identifier, description, tb_category_id, tb_financial_plans_id,
            promotion, highlights, active, published, note, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, institutionId, kind, ...productValues]
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
      merchandise.composition ?? null, merchandise.manufSignIndScale ?? null, deleted,
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
    inTransaction = false
    res.json(syncSuccess(id))
  } catch (err: any) {
    if (conn && inTransaction) await conn.rollback().catch(() => undefined)
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /merchandise/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn?.release()
  }
})

export default router
