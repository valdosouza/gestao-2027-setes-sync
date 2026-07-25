/**
 * Tipos de ENDEREÇO (tb_address, setes_central — PK id+kind).
 * Peça independente da cadeia de entidade fiscal (SRP/ISP): quem precisa
 * só de endereços importa address.* sem carregar a cadeia. NUNCA importa
 * a composição (entity-fiscal.ts) — o vínculo é só o entityId recebido.
 */

export interface AddressInput {
  kind:          string
  street:        string
  nmbr?:         string | null
  complement?:   string | null
  neighborhood?: string | null
  zipCode?:      string | null
  tbCountryId:   number
  tbStateId:     number
  tbCityId:      number
  main?:         'S' | 'N'
}

export interface AddressRow {
  kind:         string
  street:       string | null
  nmbr:         string | null
  complement:   string | null
  neighborhood: string | null
  zipCode:      string | null
  tbCountryId:  number
  tbStateId:    number
  tbCityId:     number
  main:         'S' | 'N'
  /** Nomes via JOIN — exibição nos lookups do app (campo-lookup-fk.md). */
  countryName:  string | null
  stateName:    string | null
  cityName:     string | null
}
