/**
 * Tipos da ENTITY BASE (tb_entity, setes_central) — SÓ tb_entity (SRP).
 * As peças de apoio (address/phone/social-media) e o fiscal (person/company)
 * têm arquivos próprios; a composição da cadeia vive em entity-fiscal.ts.
 * Espelho no app: apps/web/lib/app/shared/entity/domain/object_entity.dart.
 */

export interface EntityInput {
  nameCompany: string
  nickTrade:   string
  /** Data no formato YYYY-MM-DD. */
  aniversary?: string | null
}

export interface EntityRow {
  nameCompany: string | null
  nickTrade:   string | null
  aniversary:  string | null
}
