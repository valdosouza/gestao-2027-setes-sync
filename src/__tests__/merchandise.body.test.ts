import { merchandiseBody } from '@modules/sync/endpoints/merchandise'

/**
 * Contrato do /merchandise/sincronize para os campos corrigidos em
 * 2026-10-17 (Infra-IA/setes-sync/verificacao-comissao-margem-mercadoria.md):
 * D-SY5 — manufSignIndScale espelha o INDESCALA do legado; vazio/ausente =
 * "não informado" (NULL na gravação), nunca um 'S' inventado.
 * D-SY6 — application chega em TEXTO (o Sincronizador decodifica o Base64).
 */
describe('merchandiseBody: indEscala e aplicação', () => {
  const base = { id: 501, product: { description: 'PARAFUSO 6MM', categoryId: 12 } }
  const parse = (merchandise: Record<string, unknown>) =>
    merchandiseBody.parse({ ...base, merchandise }).merchandise

  it("'S' e 'N' passam como estão", () => {
    expect(parse({ manufSignIndScale: 'S' }).manufSignIndScale).toBe('S')
    expect(parse({ manufSignIndScale: 'N' }).manufSignIndScale).toBe('N')
  })

  it('vazio ou ausente = não informado (sem default)', () => {
    expect(parse({ manufSignIndScale: '' }).manufSignIndScale).toBeUndefined()
    expect(parse({ manufSignIndScale: '  ' }).manufSignIndScale).toBeUndefined()
    expect(parse({}).manufSignIndScale).toBeUndefined()
  })

  it('bloco merchandise ausente também não inventa o indicador', () => {
    expect(merchandiseBody.parse(base).merchandise.manufSignIndScale).toBeUndefined()
  })

  it('valor fora de S/N é recusado (o Delphi normaliza antes de enviar)', () => {
    expect(merchandiseBody.safeParse({ ...base, merchandise: { manufSignIndScale: 'X' } }).success).toBe(false)
  })

  it('aplicação em texto com acento e quebra de linha passa intacta', () => {
    const texto = 'Aplicação: Gol 1.6\r\nPalio 1.0'
    expect(parse({ application: texto }).application).toBe(texto)
  })
})
