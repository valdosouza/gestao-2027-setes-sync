import { orderStatusField } from '@modules/sync/sync.order-status'

/**
 * Tradução do status do pedido: flag de FATURAMENTO do legado
 * (TB_PEDIDO.PED_FATURADO) → estado do PROCESSO na web (Valdo, 2026-08-14).
 * A tradução oficial acontece no envio (Delphi); esta é a rede de transição
 * para o executável antigo — por isso o 'S' precisa virar 'F' aqui também.
 */
describe('status do pedido: legado → domínio da web', () => {
  const parse = (v: unknown) => orderStatusField.parse(v)

  it("'S' (faturado no legado) vira 'F' (fechado)", () => {
    expect(parse('S')).toBe('F')
  })

  it("'A' (em aberto) permanece 'A'", () => {
    expect(parse('A')).toBe('A')
  })

  it("'F' já no domínio novo (Delphi compilado) passa direto", () => {
    expect(parse('F')).toBe('F')
  })

  it('tolera minúscula e espaço do legado', () => {
    expect(parse('s')).toBe('F')
    expect(parse(' S ')).toBe('F')
  })

  it('ausente/nulo continua ausente/nulo — coluna é nullable', () => {
    expect(parse(undefined)).toBeUndefined()
    expect(parse(null)).toBeNull()
  })

  it('valor fora do domínio conhecido segue CRU (não se inventa estado)', () => {
    expect(parse('X')).toBe('X')
  })
})
