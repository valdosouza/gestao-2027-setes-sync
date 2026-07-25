/**
 * Tipos de FONE (tb_phone, setes_central — SINGULAR; PK id+kind).
 * Peça independente da cadeia de entidade fiscal (SRP/ISP): quem precisa
 * só de telefones importa phone.* sem carregar a cadeia. NUNCA importa
 * a composição (entity-fiscal.ts) — o vínculo é só o entityId recebido.
 */

export interface PhoneInput {
  kind:     string
  contact?: string | null
  number?:  string | null
}

export interface PhoneRow {
  kind:    string
  contact: string | null
  number:  string | null
}
