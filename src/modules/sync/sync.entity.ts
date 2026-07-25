import { PoolConnection } from 'mysql2/promise'
import { z } from 'zod'
import { HttpError } from '@shared/errors/http-error'
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
 * - Cadeia INTEIRA em setes_central (D13) — quem grava o PAPEL no schema do
 *   cliente é o endpoint chamador, sempre com id = entityId daqui.
 */

// ---------------------------------------------------------------------
// Contrato (D22): bloco `entity` padrão dos endpoints de entidade
// ---------------------------------------------------------------------

/** Email de contato — grava em tb_mailing (dedupe por UNIQUE) + vínculo. */
export const syncMailingBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  /** Grupo do vínculo: 1=principal (default), 3=nfe. */
  groupId: z.number().int().optional().default(1),
})

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
  mailings?:     Array<{ email: string; groupId: number }>
}

export interface SyncEntityResult {
  entityId:      number
  /** UUID da tb_no_doc — devolvido SEMPRE para personType 'N' (D4/D14). */
  externalCode?: string
  /** true = entity reaproveitada (documento/UUID já existia na central). */
  reused:        boolean
}

// ---------------------------------------------------------------------
// Normalização defensiva (dados gravados SEM máscara — padrão da casa)
// ---------------------------------------------------------------------

const digitsOnly = (v: string) => v.replace(/\D/g, '')

/** Remove máscara de CPF/CNPJ antes da validação Zod (defensivo — o
 *  contrato D22 pede sem máscara, mas o legado pode escorregar). */
export function stripDocumentMasks<T extends Record<string, any>>(body: T): T {
  const out: any = { ...body }
  if (out.person?.cpf)    out.person  = { ...out.person,  cpf:  digitsOnly(String(out.person.cpf)) }
  if (out.company?.cnpj)  out.company = { ...out.company, cnpj: digitsOnly(String(out.company.cnpj)) }
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

/**
 * Salva/reindexa a entidade do pacote DENTRO da transação do endpoint.
 * O chamador grava o papel (tb_customer/...) no schema do cliente com o
 * entityId devolvido — e repassa o externalCode no envelope (D14).
 */
export async function saveSyncEntity(
  conn: PoolConnection, input: SyncEntityInput
): Promise<SyncEntityResult> {
  let entityId: number
  let reused: boolean

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
  } else {
    const result = await saveEntityFiscalChain(conn, null, input)
    entityId = result.id
    reused   = result.reused
  }

  if (input.mailings !== undefined && input.mailings.length > 0) {
    await syncMailings(conn, entityId, input.mailings)
  }

  const externalCode =
    input.personType === 'N' ? await getExternalCode(conn, entityId) : undefined

  return { entityId, externalCode, reused }
}
