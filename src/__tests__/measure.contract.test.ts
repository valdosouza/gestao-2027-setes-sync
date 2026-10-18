import { merchandiseBody, merchandiseCatalogInputs } from '@modules/sync/endpoints/merchandise'
import { measureBody } from '@modules/sync/endpoints/measure'
import { resolveCatalogKey } from '@modules/sync/sync.catalog'

/**
 * D-SY10 (= D-PR39, Valdo 2026-10-18) — contrato da medida pela ABREVIAÇÃO
 * (Infra-IA/setes-sync/verificacao-comissao-margem-mercadoria.md §8.2/§10).
 */
describe('/merchandise: medida pela abreviação (stock.measureAbbreviation)', () => {
  const base = { id: 501, product: { description: 'PARAFUSO 6MM', categoryId: 12 } }
  const inputsOf = (stock: Record<string, unknown>, merchandise: Record<string, unknown> = {}) => {
    const body = merchandiseBody.parse({ ...base, stock, merchandise })
    return merchandiseCatalogInputs(body.merchandise, body.stock)
  }

  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined))
  afterEach(() => jest.restoreAllMocks())

  it('executável novo: a abreviação é a chave e a descrição vai como atributo da criação', () => {
    const { measure } = inputsOf({ measureAbbreviation: 'KG', nameMeasure: 'QUILOGRAMA' })
    expect(measure).toEqual({ abbreviation: 'KG', description: 'QUILOGRAMA' })
    expect(resolveCatalogKey('tb_measure', measure)).toEqual({ key: 'abbreviation', value: 'KG' })
  })

  it('abreviação sem descrição: a própria abreviação descreve a criação', () => {
    expect(inputsOf({ measureAbbreviation: 'CX' }).measure).toEqual({ abbreviation: 'CX', description: 'CX' })
  })

  it('executável antigo (só nameMeasure) continua aceito — resolve pela descrição', () => {
    const { measure } = inputsOf({ nameMeasure: 'UNIDADE' })
    expect(measure).toEqual({ description: 'UNIDADE' })
    expect(resolveCatalogKey('tb_measure', measure)).toEqual({ key: 'description', value: 'UNIDADE' })
  })

  it("sem medida nenhuma: o fallback 'UND' passa a ser ABREVIAÇÃO (não cria 2ª linha 'UND' sem abreviação)", () => {
    const { measure } = inputsOf({})
    expect(measure).toEqual({ abbreviation: 'UND', description: 'UNIDADE' })
    expect(resolveCatalogKey('tb_measure', measure).key).toBe('abbreviation')
    expect(inputsOf({ measureAbbreviation: '  ', nameMeasure: '' }).measure.abbreviation).toBe('UND')
  })

  it('marca e embalagem seguem pela descrição, com os fallbacks do legado', () => {
    const r = inputsOf({ namePackage: 'GARRAFA' }, { nameBrand: 'ACME' })
    expect(r.brand).toEqual({ description: 'ACME' })
    expect(r.package).toEqual({ description: 'GARRAFA' })
    const vazio = inputsOf({})
    expect(vazio.brand.description).toBe('NÃO INFORMADA')
    expect(vazio.package.description).toBe('UND')
  })

  it('abreviação acima de 5 (VARCHAR(5) do legado) é recusada', () => {
    expect(merchandiseBody.safeParse({ ...base, stock: { measureAbbreviation: 'ABCDEF' } }).success).toBe(false)
    expect(merchandiseBody.safeParse({ ...base, stock: { measureAbbreviation: 'ABCDE' } }).success).toBe(true)
  })
})

describe('/measure: abreviação obrigatória no contrato', () => {
  it('o campo tem de vir', () => {
    expect(measureBody.safeParse({ description: 'UNIDADE' }).success).toBe(false)
  })

  it("vazia ou nula (legado sem MED_ABREVIATURA) é aceita e cai na descrição", () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const vazia = measureBody.parse({ description: 'PECA', abbreviation: '' })
    expect(resolveCatalogKey('tb_measure', vazia)).toEqual({ key: 'description', value: 'PECA' })
    const nula = measureBody.parse({ description: 'PECA', abbreviation: null })
    expect(resolveCatalogKey('tb_measure', nula).key).toBe('description')
    jest.restoreAllMocks()
  })

  it('até 5 caracteres (o max(5) cabe na coluna central de 6 — D-PR35)', () => {
    expect(measureBody.safeParse({ description: 'X', abbreviation: 'ABCDE' }).success).toBe(true)
    expect(measureBody.safeParse({ description: 'X', abbreviation: 'ABCDEF' }).success).toBe(false)
  })
})
