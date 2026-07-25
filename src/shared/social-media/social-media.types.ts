/**
 * Tipos de REDE SOCIAL (tb_social_media, setes_central — PK id+kind).
 * Peça independente da cadeia de entidade fiscal (SRP/ISP): quem precisa
 * só de redes sociais importa social-media.* sem carregar a cadeia. NUNCA
 * importa a composição (entity-fiscal.ts) — o vínculo é só o entityId.
 */

export interface SocialMediaInput {
  kind:  string
  link?: string | null
}

export interface SocialMediaRow {
  kind: string
  link: string | null
}
