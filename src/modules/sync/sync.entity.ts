import { PoolConnection } from 'mysql2/promise'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'
import {
  EntityFiscalInput,
  entityFiscalBody,
  withFiscalRefinements,
  saveEntityFiscalChain,
} from '@shared/entity'

/**
 * MOTOR DE REINDEXAÇÃO do sincronizador (decisões D3/D4/D13 do prompt
 * prompt_revisao_sincronizador_setes_sync.md) — o coração da revisão.
 *
 * Regras:
 * - O código do Firebird (emp_codigo) NUNCA indexa nada (D3).
 * - COM documento (F/J): saveEntityFiscalChain deduplica por CPF/CNPJ
 *   DENTRO da transação (FOR UPDATE) — mesmo CNPJ vindo de clientes
 *   diferentes da Setes cai na MESMA entity (D3).
 * - SEM documento (N):
 *     · payload SEM externalCode → cria entity + tb_no_doc (UUID) e DEVOLVE
 *       o externalCode; o Sincronizador grava em tb_empresa.externalCode (D4).
 *     · payload COM externalCode → resolve a entity pelo UUID; não achou =
 *       erro (o Firebird diz ter um vínculo que a central não conhece).
 * - GRADUAÇÃO (prompt_correcao_documento_entidade.md, 4 decisões 2026-07-25):
 *   F/J COM externalCode = o sem-doc foi corrigido no Gestão. A entity do
 *   externalCode GANHA o documento (mesmo tb_entity.id — histórico intacto;
 *   o toggle do upsertFiscal soft-deleta tb_no_doc) e o envelope devolve
 *   clearExternalCode:true para o Sincronizador limpar o vínculo (decisão 1).
 *   Documento já em OUTRA entity → NUNCA mescla: conflito em tb_sync_conflict
 *   (decisão 2) e a entity segue como sem-doc. Órfão: segue por documento SÓ
 *   se o documento estiver livre (decisão 3); ocupado → 409 + conflito.
 * - Cadeia INTEIRA em setes_central (D13) — quem grava o PAPEL no schema do
 *   cliente é o endpoint chamador, sempre com id = entityId daqui.
 */

// ---------------------------------------------------------------------
// Contrato (D22): bloco `entity` padrão dos endpoints de entidade
// ---------------------------------------------------------------------

/** Email de contato — grava em tb_mailing (dedupe por UNIQUE) + vínculo.
 *  Email INVÁLIDO do legado = SEM email (2026-08-01, precedente da decisão
 *  "documento inválido = sem documento"): a entrada vira null no preprocess
 *  e é filtrada no saveSyncEntity — lixo de cadastro antigo não pode barrar
 *  o cliente inteiro. */
const validEmail = z.string().trim().toLowerCase().email()

export const syncMailingBody = z.preprocess(
  v => {
    const email = (v as { email?: unknown })?.email
    // Mesmo validador do schema final — o que não passar ali vira null AQUI
    // (nunca 400).
    if (!validEmail.safeParse(email).success) {
      logger.warn(`Email inválido do legado descartado: ${JSON.stringify(email)}`)
      return null
    }
    return v
  },
  z.object({
    email: validEmail,
    /** Grupo do vínculo: 1=principal (default), 3=nfe. */
    groupId: z.number().int().optional().default(1),
  }).nullable()
)

/**
 * Bloco de entidade do contrato de sincronização = entityFiscalBody da
 * cadeia (D22: mesmo shape do EntityFiscalInput da setes-api) + extensões
 * exclusivas do sync: externalCode (D4) e mailings.
 * withFiscalRefinements SEMPRE por último (toggle F/J/N + kinds únicos).
 */
export const syncEntityBody = withFiscalRefinements(
  entityFiscalBody.extend({
    externalCode: z.string().uuid().optional(),
    mailings:     z.array(syncMailingBody).optional(),
  })
)

export type SyncEntityInput = EntityFiscalInput & {
  externalCode?: string
  // null = email inválido do legado descartado no preprocess (filtrado no save)
  mailings?:     Array<{ email: string; groupId: number } | null>
}

export interface SyncEntityResult {
  entityId:      number
  /** UUID da tb_no_doc — devolvido SEMPRE para personType 'N' (D4/D14). */
  externalCode?: string
  /** true = entity reaproveitada (documento/UUID já existia na central). */
  reused:        boolean
  /** true = graduação concluída (decisão 1): o Sincronizador deve LIMPAR o
   *  EXTERNALCODE no Firebird — o documento passou a ser o índice. */
  clearExternalCode?: boolean
}

/** Contexto do endpoint chamador — usado no registro de conflitos (decisão 2). */
export interface SyncContext {
  origin:        string
  institutionId: number
}

// ---------------------------------------------------------------------
// Normalização defensiva (dados gravados SEM máscara — padrão da casa)
// ---------------------------------------------------------------------

const digitsOnly = (v: string) => v.replace(/\D/g, '')

/** Remove máscara de CPF/CNPJ antes da validação Zod (defensivo — o
 *  contrato D22 pede sem máscara, mas o legado pode escorregar).
 *  2026-08-03: também normaliza nome×fantasia — legado com um dos dois em
 *  branco (ex.: TB_USUARIO sem apelido) herda o outro em vez de 400. */
export function stripDocumentMasks<T extends Record<string, any>>(body: T): T {
  const out: any = { ...body }
  if (out.person?.cpf)    out.person  = { ...out.person,  cpf:  digitsOnly(String(out.person.cpf)) }
  if (out.company?.cnpj)  out.company = { ...out.company, cnpj: digitsOnly(String(out.company.cnpj)) }
  if (out.entity) {
    const name = String(out.entity.nameCompany ?? '').trim()
    const nick = String(out.entity.nickTrade ?? '').trim()
    if (name && !nick)      out.entity = { ...out.entity, nickTrade: name }
    else if (nick && !name) out.entity = { ...out.entity, nameCompany: nick }
  }
  return out
}

// ---------------------------------------------------------------------
// Persistência
// ---------------------------------------------------------------------

/**
 * Resolve REFERÊNCIA a outra entidade por documento (vendedor/transportador
 * do cliente etc.). CPF (11) ou CNPJ (14), sem máscara. null = não existe
 * na central (o endpoint decide: 409 de reenvio ou campo NULL).
 */
export async function findEntityIdByDocument(
  conn: PoolConnection, document: string
): Promise<number | null> {
  const digits = document.replace(/\D/g, '')
  if (digits.length === 11) {
    const [rows] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_person WHERE cpf = ? AND deleted = 'N' LIMIT 1`, [digits])
    return rows.length ? Number(rows[0].id) : null
  }
  if (digits.length === 14) {
    const [rows] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_company WHERE cnpj = ? AND deleted = 'N' LIMIT 1`, [digits])
    return rows.length ? Number(rows[0].id) : null
  }
  return null
}

async function findEntityIdByExternalCode(
  conn: PoolConnection, externalCode: string
): Promise<number | null> {
  const [rows] = await conn.query<any[]>(
    `SELECT id FROM setes_central.tb_no_doc
     WHERE external_id = ? AND deleted = 'N' LIMIT 1 FOR UPDATE`,
    [externalCode]
  )
  return rows.length > 0 ? Number(rows[0].id) : null
}

async function getExternalCode(
  conn: PoolConnection, entityId: number
): Promise<string | undefined> {
  const [rows] = await conn.query<any[]>(
    `SELECT external_id FROM setes_central.tb_no_doc
     WHERE id = ? AND deleted = 'N' LIMIT 1`,
    [entityId]
  )
  return rows.length > 0 ? String(rows[0].external_id) : undefined
}

/** Emails de contato: tb_mailing deduplicada por UNIQUE(email) + vínculo
 *  tb_entity_has_mailing no grupo informado (mesmo padrão do users da
 *  setes-api; aqui sem exclusividade — contato pode ter N emails). */
async function syncMailings(
  conn: PoolConnection, entityId: number,
  mailings: Array<{ email: string; groupId: number }>
): Promise<void> {
  for (const m of mailings) {
    const [found] = await conn.query<any[]>(
      `SELECT id, deleted FROM setes_central.tb_mailing WHERE email = ? FOR UPDATE`,
      [m.email]
    )
    let mailingId: number
    if (found.length > 0) {
      mailingId = Number(found[0].id)
      if (found[0].deleted === 'S') {
        await conn.query(
          `UPDATE setes_central.tb_mailing SET deleted = 'N', updated_at = NOW() WHERE id = ?`,
          [mailingId]
        )
      }
    } else {
      const [rows] = await conn.query<any[]>(
        `SELECT COALESCE(MAX(id), 0) + 1 AS nextId FROM setes_central.tb_mailing FOR UPDATE`
      )
      mailingId = Number(rows[0].nextId)
      await conn.query(
        `INSERT INTO setes_central.tb_mailing (id, email, created_at, updated_at)
         VALUES (?, ?, NOW(), NOW())`,
        [mailingId, m.email]
      )
    }
    await conn.query(
      `INSERT INTO setes_central.tb_entity_has_mailing
         (tb_entity_id, tb_mailing_id, tb_mailing_group_id, created_at, updated_at, deleted)
       VALUES (?, ?, ?, NOW(), NOW(), 'N')
       ON DUPLICATE KEY UPDATE deleted = 'N', updated_at = NOW()`,
      [entityId, mailingId, m.groupId]
    )
  }
}

/** O externalCode pertence à (soft-deletada ou não) tb_no_doc DESTA entity?
 *  Distingue a regravação pós-graduação (caso B — o Firebird ainda não limpou
 *  o EXTERNALCODE e a tb_no_doc já foi soft-deletada pelo toggle) de um
 *  órfão genuíno. */
async function externalCodeBelongsToEntity(
  conn: PoolConnection, externalCode: string, entityId: number
): Promise<boolean> {
  const [rows] = await conn.query<any[]>(
    `SELECT 1 FROM setes_central.tb_no_doc WHERE external_id = ? AND id = ? LIMIT 1`,
    [externalCode, entityId]
  )
  return rows.length > 0
}

/** Decisão 2: fila central de conflitos para ação manual. Usa o POOL
 *  (autocommit) — precisa sobreviver ao rollback do endpoint (caso 409). */
async function registerSyncConflict(
  ctx: SyncContext | undefined, document: string, externalCode: string,
  entityIdDoc: number | null, entityIdExt: number | null, message: string
): Promise<void> {
  logger.warn('Conflito de sincronização de entidade', {
    ctx, document, externalCode, entityIdDoc, entityIdExt, message,
  })
  if (!ctx) return
  await pool.query(
    `INSERT INTO setes_central.tb_sync_conflict
       (tb_institution_id, document, external_code, tb_entity_id_doc,
        tb_entity_id_ext, origin, message, resolved, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'N', NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       tb_entity_id_doc = VALUES(tb_entity_id_doc),
       tb_entity_id_ext = VALUES(tb_entity_id_ext),
       message = VALUES(message), resolved = 'N', updated_at = NOW()`,
    [ctx.institutionId, document, externalCode, entityIdDoc, entityIdExt, ctx.origin, message]
  )
}

// ---------------------------------------------------------------------
// Papéis-SENTINELA (decisão Valdo — opção b, 2026-08-03): a venda balcão
// do legado não identifica cliente/vendedor (documento ausente, zerado ou
// sentinela). O processo resolve para papéis autocriados por institution
// (precedente da forma "Carteira" autocreate): entity 'N' (sem doc, UUID)
// em setes_central + papel no schema do cliente. Idempotência pelo NOME +
// entity sem-documento (tb_no_doc viva) — um cliente real homônimo COM
// documento nunca é confundido.
// ---------------------------------------------------------------------

const SENTINEL_NAMES = {
  customer: 'CONSUMIDOR FINAL',
  salesman: 'VENDEDOR PADRAO',
} as const

export async function resolveSentinelRole(
  conn: PoolConnection, institutionId: number, schemaName: string,
  role: keyof typeof SENTINEL_NAMES
): Promise<number> {
  const name  = SENTINEL_NAMES[role]
  const table = role === 'customer' ? 'tb_customer' : 'tb_salesman'
  const [rows] = await conn.query<any[]>(
    `SELECT p.id FROM \`${schemaName}\`.${table} p
     JOIN setes_central.tb_entity e ON e.id = p.id
     JOIN setes_central.tb_no_doc n ON n.id = p.id AND n.deleted = 'N'
     WHERE p.tb_institution_id = ? AND e.name_company = ?
     LIMIT 1`,
    [institutionId, name]
  )
  if (rows.length) return rows[0].id

  const { id: entityId } = await saveEntityFiscalChain(conn, null, {
    entity: { nameCompany: name, nickTrade: name },
    personType: 'N', person: null, company: null,
  } as EntityFiscalInput)

  if (role === 'salesman') {
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_salesman
         (id, tb_institution_id, active, flex_value, deleted, created_at, updated_at)
       VALUES (?, ?, 'S', 0, 'N', NOW(), NOW())
       ON DUPLICATE KEY UPDATE deleted = 'N', updated_at = NOW()`,
      [entityId, institutionId]
    )
  } else {
    await conn.query(
      `INSERT INTO \`${schemaName}\`.tb_customer
         (id, tb_institution_id, active, deleted, created_at, updated_at)
       VALUES (?, ?, 'S', 'N', NOW(), NOW())
       ON DUPLICATE KEY UPDATE deleted = 'N', updated_at = NOW()`,
      [entityId, institutionId]
    )
  }
  logger.warn(
    `Papel sentinela '${name}' (${role}) criado para institution ${institutionId} — venda sem documento`)
  return entityId
}

/** Documento (CNPJ/CPF) do PRÓPRIO institution — mesma herança por PK do
 *  trio geográfico (tb_institution.id É a tb_entity.id). null = institution
 *  sem cadeia fiscal própria completa (não deveria acontecer em produção). */
export async function getInstitutionDocument(
  conn: PoolConnection, institutionId: number
): Promise<string | null> {
  const [company] = await conn.query<any[]>(
    `SELECT cnpj FROM setes_central.tb_company WHERE id = ? LIMIT 1`, [institutionId])
  if (company.length) return String(company[0].cnpj)
  const [person] = await conn.query<any[]>(
    `SELECT cpf FROM setes_central.tb_person WHERE id = ? LIMIT 1`, [institutionId])
  return person.length ? String(person[0].cpf) : null
}

// ---------------------------------------------------------------------
// Vendedor = a PRÓPRIA empresa (Valdo, 2026-08-09): venda de balcão do
// legado grava, como código do vendedor, o EMP_CODIGO da própria loja em
// vez de deixar o campo vazio — "amador" mas já é o comportamento real do
// legado (achado da investigação do sync-errors.log da Pipoteca, onde
// ~79% dos pedidos travavam em SALESMAN_NOT_SYNCED exatamente por isso).
// Em vez de tratar isso como 409 pra sempre (a empresa nunca vai "se
// sincronizar como vendedor" sozinha por nenhum endpoint /salesman), o
// institution vira seu PRÓPRIO vendedor-fallback: papel real (não
// sentinela sem-doc) na entity que já existe (tb_institution.id).
// Precedência de papéis (2026-07-17): Salesman SEMPRE é Collaborator —
// os dois papéis nascem juntos com o MESMO id.
// ---------------------------------------------------------------------

export async function resolveSelfSalesman(
  conn: PoolConnection, institutionId: number, schemaName: string
): Promise<void> {
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_collaborator
       (id, tb_institution_id, active, deleted, created_at, updated_at)
     VALUES (?, ?, 'S', 'N', NOW(), NOW())
     ON DUPLICATE KEY UPDATE deleted = 'N', updated_at = NOW()`,
    [institutionId, institutionId]
  )
  await conn.query(
    `INSERT INTO \`${schemaName}\`.tb_salesman
       (id, tb_institution_id, active, flex_value, deleted, created_at, updated_at)
     VALUES (?, ?, 'S', 0, 'N', NOW(), NOW())
     ON DUPLICATE KEY UPDATE deleted = 'N', updated_at = NOW()`,
    [institutionId, institutionId]
  )
  logger.warn(
    `Vendedor-fallback: institution ${institutionId} promovido a colaborador/vendedor de si mesmo ` +
    `(venda sem vendedor identificado no legado)`)
}

/** Trio geográfico do endereço do PRÓPRIO institution (herança por PK:
 *  tb_institution.id É a entity id — endereço main na setes_central). */
async function getInstitutionGeoTrio(
  conn: PoolConnection, institutionId: number
): Promise<{ country: number; state: number; city: number } | null> {
  const [rows] = await conn.query<any[]>(
    `SELECT tb_country_id AS country, tb_state_id AS state, tb_city_id AS city
     FROM setes_central.tb_address
     WHERE id = ? AND deleted = 'N'
     ORDER BY (main = 'S') DESC, kind
     LIMIT 1`,
    [institutionId]
  )
  return rows.length ? rows[0] : null
}

/**
 * FALLBACK GEOGRÁFICO (decisão Valdo 2026-08-01, diagnóstico do
 * sync-errors.log): país/estado/cidade da central são MIGRADOS do Firebird —
 * um id que não existe é dado sujo do legado e NÃO pode derrubar o cadastro
 * (a 1ª rodada real estourava a FK de tb_state_id em 500). Endereço com
 * qualquer id do trio inexistente cai para o trio COMPLETO do próprio
 * institution (troca parcial criaria cidade de um estado em outro). Sem
 * endereço no institution, segue o fluxo normal (409 legível do
 * ensureAddressRefs / cidade placeholder).
 */
async function applyGeoFallback(
  conn: PoolConnection, input: SyncEntityInput, institutionId?: number
): Promise<void> {
  if (!institutionId || !input.addresses?.length) return
  let trio: { country: number; state: number; city: number } | null | undefined
  for (const a of input.addresses) {
    const [checks] = await conn.query<any[]>(
      `SELECT
         (SELECT COUNT(*) FROM setes_central.tb_country WHERE id = ?) AS country,
         (SELECT COUNT(*) FROM setes_central.tb_state   WHERE id = ?) AS state,
         (SELECT COUNT(*) FROM setes_central.tb_city    WHERE id = ?) AS city`,
      [a.tbCountryId, a.tbStateId, a.tbCityId]
    )
    if (checks[0].country && checks[0].state && checks[0].city) continue
    if (trio === undefined) trio = await getInstitutionGeoTrio(conn, institutionId)
    if (!trio) return
    logger.warn(
      `Geo inexistente no endereço kind='${a.kind}' (país ${a.tbCountryId}/UF ` +
      `${a.tbStateId}/cidade ${a.tbCityId}) — fallback para o trio do institution ${institutionId}`
    )
    a.tbCountryId = trio.country
    a.tbStateId   = trio.state
    a.tbCityId    = trio.city
  }
}

/**
 * Salva/reindexa a entidade do pacote DENTRO da transação do endpoint.
 * O chamador grava o papel (tb_customer/...) no schema do cliente com o
 * entityId devolvido — e repassa externalCode/clearExternalCode no envelope.
 */
export async function saveSyncEntity(
  conn: PoolConnection, input: SyncEntityInput, ctx?: SyncContext
): Promise<SyncEntityResult> {
  let entityId: number
  let reused: boolean
  let clearExternalCode: boolean | undefined

  await applyGeoFallback(conn, input, ctx?.institutionId)

  const doc = input.personType === 'F' ? input.person?.cpf
            : input.personType === 'J' ? input.company?.cnpj
            : undefined

  if (input.personType === 'N' && input.externalCode) {
    const existing = await findEntityIdByExternalCode(conn, input.externalCode)
    if (existing === null) {
      throw new HttpError(
        404,
        `externalCode não encontrado na central: ${input.externalCode}`,
        [{ field: 'externalCode', message: 'UUID desconhecido — remova o externalCode para gerar um novo' }],
        'EXTERNAL_CODE_NOT_FOUND'
      )
    }
    const result = await saveEntityFiscalChain(conn, existing, input)
    entityId = result.id
    reused   = true
  } else if (doc && input.externalCode) {
    // GRADUAÇÃO (prompt_correcao_documento_entidade.md): sem-doc corrigido
    const docId = await findEntityIdByDocument(conn, doc)
    const extId = await findEntityIdByExternalCode(conn, input.externalCode)

    if (extId !== null && (docId === null || docId === extId)) {
      // Caso A (documento livre) — a entity do externalCode ganha o documento;
      // o toggle do upsertFiscal soft-deleta a tb_no_doc. Mesmo id, histórico intacto.
      const result = await saveEntityFiscalChain(conn, extId, input)
      entityId = result.id
      reused   = true
      clearExternalCode = true
    } else if (extId !== null && docId !== null) {
      // Caso C — documento já pertence a OUTRA entity: NUNCA mescla (decisão 2).
      // A entity do externalCode segue atualizada como SEM-DOC; ação manual.
      await registerSyncConflict(ctx, doc, input.externalCode, docId, extId,
        'Documento já pertence a outra entity — graduação bloqueada, ação manual')
      const asNoDoc: SyncEntityInput = { ...input, personType: 'N', person: null, company: null }
      const result = await saveEntityFiscalChain(conn, extId, asNoDoc)
      entityId = result.id
      reused   = true
    } else if (docId !== null) {
      if (await externalCodeBelongsToEntity(conn, input.externalCode, docId)) {
        // Caso B — regravação pós-graduação (tb_no_doc já soft-deletada, o
        // Firebird ainda não limpou o EXTERNALCODE): idempotente + limpar de novo.
        const result = await saveEntityFiscalChain(conn, docId, input)
        entityId = result.id
        reused   = true
        clearExternalCode = true
      } else {
        // Caso D2 — órfão E documento ocupado (refinamento do Valdo na
        // decisão 3): nada é gravado automaticamente; conflito manual.
        await registerSyncConflict(ctx, doc, input.externalCode, docId, null,
          'externalCode órfão com documento já ocupado — nada gravado, ação manual')
        throw new HttpError(
          409,
          `externalCode órfão e documento ${doc} já pertence a outra entity`,
          [{ field: 'externalCode', message: 'conflito registrado — resolver manualmente' }],
          'EXTERNAL_CODE_ORPHAN'
        )
      }
    } else {
      // Caso D1 — órfão com documento LIVRE (decisão 3): o documento vira o
      // índice; cria/atualiza por ele e manda limpar o órfão do Firebird.
      logger.warn('externalCode órfão descartado — seguindo por documento', {
        ctx, externalCode: input.externalCode, document: doc,
      })
      const result = await saveEntityFiscalChain(conn, null, input)
      entityId = result.id
      reused   = result.reused
      clearExternalCode = true
    }
  } else {
    const result = await saveEntityFiscalChain(conn, null, input)
    entityId = result.id
    reused   = result.reused
  }

  // Entradas null = email inválido do legado descartado no preprocess
  const validMailings = (input.mailings ?? []).filter(
    (m): m is { email: string; groupId: number } => m !== null
  )
  if (validMailings.length > 0) {
    await syncMailings(conn, entityId, validMailings)
  }

  const externalCode =
    input.personType === 'N' ? await getExternalCode(conn, entityId) : undefined

  return { entityId, externalCode, reused, clearExternalCode }
}
