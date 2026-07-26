/**
 * Tipos FISCAIS — identificação da entity: tb_person (PF) × tb_company (PJ)
 * × tb_no_doc (sem documento), setes_central. Peça independente da cadeia
 * (SRP/ISP): NUNCA importa a composição (entity-fiscal.ts) — o vínculo é só
 * o entityId recebido por parâmetro.
 *
 * 'N' = sem documento (Fase 3 Entidade Única, decisão 4): pessoa que não
 * fornece CPF/CNPJ. Identificada por tb_no_doc.external_id (UUID v4 gerado
 * no backend; na sincronia futura, a chave do legado).
 */

export type PersonType = 'F' | 'J' | 'N'

export interface PersonInput {
  cpf:       string
  rg?:       string | null
  birthday?: string | null
}

export interface CompanyInput {
  cnpj:          string
  ie?:           string | null
  im?:           string | null
  dtFoundation?: string | null
}

/**
 * Toggle fiscal TRIPLO: 'F' preenche person, 'J' preenche company,
 * 'N' nenhum dos dois (tb_no_doc é gerada pelo backend).
 */
export interface FiscalInput {
  personType: PersonType
  person?:    PersonInput | null
  company?:   CompanyInput | null
}

export interface PersonRow {
  cpf:      string
  rg:       string | null
  birthday: string | null
}

export interface CompanyRow {
  cnpj:         string
  ie:           string | null
  im:           string | null
  dtFoundation: string | null
}

export interface NoDocRow {
  externalId: string
}
