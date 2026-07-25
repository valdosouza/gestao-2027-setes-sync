import { z } from 'zod'
import { PoolConnection } from 'mysql2/promise'
import { EntityInput, EntityRow } from './entity.types'
import { entityBody } from './entity.dto'
import {
  nextEntityId, insertEntity, updateEntity, getEntityBase,
} from './entity.repository'
import {
  PersonType, FiscalInput, PersonRow, CompanyRow, NoDocRow,
} from '../fiscal/fiscal.types'
import { personBody, companyBody } from '../fiscal/fiscal.dto'
import {
  upsertFiscal, getPerson, getCompany, getNoDoc,
  findEntityIdByCpf, findEntityIdByCnpj,
} from '../fiscal/fiscal.repository'
import { HttpError } from '../errors/http-error'
import { AddressInput, AddressRow } from '../address/address.types'
import { addressBody } from '../address/address.dto'
import { syncAddresses, listAddresses } from '../address/address.repository'
import { PhoneInput, PhoneRow } from '../phone/phone.types'
import { phoneBody } from '../phone/phone.dto'
import { syncPhones, listPhones } from '../phone/phone.repository'
import { SocialMediaInput, SocialMediaRow } from '../social-media/social-media.types'
import { socialMediaBody } from '../social-media/social-media.dto'
import { syncSocialMedia, listSocialMedia } from '../social-media/social-media.repository'

/**
 * CAMADA DE COMPOSIÇÃO da cadeia de entidade fiscal (skill
 * cadastro-entidade-fiscal.md) — o ÚNICO arquivo que importa as peças
 * (entity, fiscal, address, phone, social-media) para compor a cadeia.
 * Direção de dependência: composição → peças; as peças NUNCA importam daqui.
 *
 * A cadeia opera SEMPRE em setes_central (o schema do cliente tem só a
 * tabela concreta, FK cross-schema) — a tabela concreta é responsabilidade
 * do repository do módulo consumidor (institutions, futuros customers...).
 */

// ---------------------------------------------------------------------
// Tipos compostos
// ---------------------------------------------------------------------

/**
 * Cadeia completa enviada no POST/PUT (person XOR company via personType).
 * Listas: `undefined` = NÃO TOCAR (proteção pós-incidente E2E 2026-07-15 —
 * um payload sem as listas soft-deletava tudo via last-write-wins);
 * `[]` explícito = limpar todos os kinds (comportamento deliberado).
 */
export interface EntityFiscalInput extends FiscalInput {
  entity:       EntityInput
  addresses?:   AddressInput[]
  phones?:      PhoneInput[]
  socialMedia?: SocialMediaInput[]
}

/**
 * Leitura COMPLETA da cadeia (entity + fiscal + 3 listas deleted='N').
 * Os concretos estendem com seus campos (ex.: InstitutionFull acrescenta
 * schemaName/active).
 */
export interface EntityFiscalFull {
  id:          number
  entity:      EntityRow
  personType:  PersonType
  person:      PersonRow | null
  company:     CompanyRow | null
  noDoc:       NoDocRow | null
  addresses:   AddressRow[]
  phones:      PhoneRow[]
  socialMedia: SocialMediaRow[]
}

// ---------------------------------------------------------------------
// DTO composto (Zod)
// ---------------------------------------------------------------------

/**
 * Bloco fiscal completo, SEM effects — os concretos estendem daqui e
 * aplicam withFiscalRefinements POR ÚLTIMO (`.extend` não existe em
 * ZodEffects).
 */
export const entityFiscalBody = z.object({
  entity:      entityBody,
  personType:  z.enum(['F', 'J', 'N']),
  person:      personBody.nullable().optional(),
  company:     companyBody.nullable().optional(),
  // Sem .default([]): lista AUSENTE fica undefined (não toca no banco);
  // só [] explícito limpa — ver comentário do EntityFiscalInput.
  addresses:   z.array(addressBody).optional(),
  phones:      z.array(phoneBody).optional(),
  socialMedia: z.array(socialMediaBody).optional(),
})

type FiscalShape = z.infer<typeof entityFiscalBody>

/**
 * Toggle TRIPLO: 'F' exige person (sem company); 'J' exige company (sem
 * person); 'N' (sem documento — decisão 4 da Fase 3) não aceita nenhum dos
 * dois (a tb_no_doc é gerada pelo backend).
 */
function checkFiscalToggle(data: FiscalShape, ctx: z.RefinementCtx): void {
  if (data.personType === 'F') {
    if (!data.person) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['person'],
        message: "personType='F' exige o objeto person (CPF)" })
    }
    if (data.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company'],
        message: "personType='F' não aceita o objeto company" })
    }
  } else if (data.personType === 'J') {
    if (!data.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company'],
        message: "personType='J' exige o objeto company (CNPJ)" })
    }
    if (data.person) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['person'],
        message: "personType='J' não aceita o objeto person" })
    }
  } else {
    if (data.person) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['person'],
        message: "personType='N' (sem documento) não aceita o objeto person" })
    }
    if (data.company) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['company'],
        message: "personType='N' (sem documento) não aceita o objeto company" })
    }
  }
}

/** Kind é PK junto com o id (tb_address/tb_phone/tb_social_media) — único por lista. */
function checkUniqueKinds(data: FiscalShape, ctx: z.RefinementCtx): void {
  const lists: Array<[string, Array<{ kind: string }>]> = [
    ['addresses', data.addresses ?? []],
    ['phones', data.phones ?? []],
    ['socialMedia', data.socialMedia ?? []],
  ]
  for (const [name, list] of lists) {
    const seen = new Set<string>()
    for (const item of list) {
      if (seen.has(item.kind)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name],
          message: `kind duplicado em ${name}: "${item.kind}"` })
      }
      seen.add(item.kind)
    }
  }
}

/**
 * Aplica as validações da cadeia (toggle fiscal XOR + kinds únicos) a um
 * schema que estende entityFiscalBody. SEMPRE por último no concreto.
 */
export function withFiscalRefinements<Out extends FiscalShape, In>(
  schema: z.ZodType<Out, z.ZodTypeDef, In>
): z.ZodType<Out, z.ZodTypeDef, In> {
  return schema
    .superRefine(checkFiscalToggle)
    .superRefine(checkUniqueKinds)
}

// ---------------------------------------------------------------------
// Persistência composta
// ---------------------------------------------------------------------

/** Resultado do salvar: id da entity + se ela foi REAPROVEITADA (decisão 9). */
export interface SaveChainResult {
  id:     number
  reused: boolean
}

/**
 * EDIÇÃO: o documento informado não pode pertencer a OUTRA entity (cobre
 * também o upgrade N→F/J — decisão 6: doc já existente → 409 orientando
 * correção manual; merge não será construído). 409 com erro por campo
 * (decisão 20 da Fase 2). personType='N' não tem documento — nada a checar.
 */
async function assertDocFreeForEntity(
  conn: PoolConnection, id: number, input: EntityFiscalInput
): Promise<void> {
  if (input.personType === 'F') {
    const owner = await findEntityIdByCpf(input.person!.cpf, conn, true)
    if (owner !== null && owner !== id) {
      throw new HttpError(409, 'CPF já cadastrado em outro registro',
        [{ field: 'cpf', message: 'CPF já cadastrado em outro registro' }],
        'DUP_DOCUMENT')
    }
  } else if (input.personType === 'J') {
    const owner = await findEntityIdByCnpj(input.company!.cnpj, conn, true)
    if (owner !== null && owner !== id) {
      throw new HttpError(409, 'CNPJ já cadastrado em outro registro',
        [{ field: 'cnpj', message: 'CNPJ já cadastrado em outro registro' }],
        'DUP_DOCUMENT')
    }
  }
}

/**
 * CRIAÇÃO — buscar-antes-de-criar (Fase 3, decisões 1 e 9): resolve a entity
 * dona do documento DENTRO da transação, com FOR UPDATE (segura a linha até
 * o commit; corrida de dois POSTs com o mesmo doc morre no lock ou no UNIQUE
 * de cpf/cnpj → ER_DUP_ENTRY → 409 do módulo). 'N' nunca deduplica (decisão 5).
 */
async function resolveExistingByDocument(
  conn: PoolConnection, input: EntityFiscalInput
): Promise<number | null> {
  if (input.personType === 'F') return findEntityIdByCpf(input.person!.cpf, conn, true)
  if (input.personType === 'J') return findEntityIdByCnpj(input.company!.cnpj, conn, true)
  return null
}

/**
 * Orquestra a cadeia inteira DENTRO da transação do concreto:
 * - id null (CRIAR): busca a entity pelo documento — achou → REUSA o id e
 *   ATUALIZA a cadeia (last-write-wins, decisão 1); não achou → MAX+1 FOR
 *   UPDATE e INSERT. O chamador NUNCA manda entityId (decisão 9).
 * - id informado (EDITAR): valida que o doc não pertence a outra entity e
 *   atualiza.
 * A tabela concreta (tb_institution, tb_customer...) é responsabilidade do
 * repository do módulo consumidor — inclusive o 409 de papel duplicado
 * (decisão 2). [updatedBy] = userId do JWT (rastro do last-write-wins).
 */
export async function saveEntityFiscalChain(
  conn: PoolConnection, id: number | null, input: EntityFiscalInput,
  updatedBy: number | null = null
): Promise<SaveChainResult> {
  let entityId: number
  let reused = false

  if (id === null) {
    const existing = await resolveExistingByDocument(conn, input)
    if (existing !== null) {
      entityId = existing
      reused   = true
      await updateEntity(conn, entityId, input.entity, updatedBy)
    } else {
      entityId = await nextEntityId(conn)
      await insertEntity(conn, entityId, input.entity, updatedBy)
    }
  } else {
    await assertDocFreeForEntity(conn, id, input)
    entityId = id
    await updateEntity(conn, entityId, input.entity, updatedBy)
  }

  await upsertFiscal(conn, entityId, input, updatedBy)
  // Lista undefined = não tocar; [] explícito = limpar (proteção 2026-07-15)
  if (input.addresses   !== undefined) await syncAddresses(conn, entityId, input.addresses, updatedBy)
  if (input.phones      !== undefined) await syncPhones(conn, entityId, input.phones, updatedBy)
  if (input.socialMedia !== undefined) await syncSocialMedia(conn, entityId, input.socialMedia, updatedBy)
  return { id: entityId, reused }
}

/**
 * Leitura COMPLETA da cadeia (fora de transação — pool). null se a entity
 * não existe. O concreto compõe com a própria tabela.
 */
export async function getEntityFiscalFull(id: number): Promise<EntityFiscalFull | null> {
  const entity = await getEntityBase(id)
  if (!entity) return null

  const person      = await getPerson(id)
  const company     = await getCompany(id)
  const noDoc       = await getNoDoc(id)
  const addresses   = await listAddresses(id)
  const phones      = await listPhones(id)
  const socialMedia = await listSocialMedia(id)

  return {
    id,
    entity,
    personType: person ? 'F' : company ? 'J' : 'N',
    person,
    company,
    noDoc,
    addresses,
    phones,
    socialMedia,
  }
}
