/**
 * Validadores COMPARTILHADOS (Fase 2 campos configuráveis, decisão 18):
 * funções puras usadas pelos DTOs Zod e services de qualquer módulo.
 * Espelho no app: package setes_validators (decisão 22) — manter as regras
 * IDÊNTICAS nos dois lados (API = fonte da verdade, decisão 1).
 *
 * Dados chegam e são gravados SEM máscara (decisão 19): as funções de
 * CPF/CNPJ/CEP/fone esperam somente dígitos.
 */

/** true se o valor contém apenas dígitos (vazio conta como true). */
export function isOnlyDigits(value: string): boolean {
  return /^\d*$/.test(value)
}

/** Dígito verificador de CPF (módulo 11). Espera 11 dígitos sem máscara. */
export function isValidCpf(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf)) return false
  if (/^(\d)\1{10}$/.test(cpf)) return false // 111.111.111-11 etc.

  const digits = cpf.split('').map(Number)
  for (const position of [9, 10]) {
    let sum = 0
    for (let i = 0; i < position; i++) sum += digits[i] * (position + 1 - i)
    const check = ((sum * 10) % 11) % 10
    if (check !== digits[position]) return false
  }
  return true
}

/** Dígito verificador de CNPJ (pesos 2..9). Espera 14 dígitos sem máscara. */
export function isValidCnpj(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj)) return false
  if (/^(\d)\1{13}$/.test(cnpj)) return false

  const digits = cnpj.split('').map(Number)
  for (const position of [12, 13]) {
    let weight = position - 7 // 5 para o 1º dígito, 6 para o 2º
    let sum = 0
    for (let i = 0; i < position; i++) {
      sum += digits[i] * weight
      weight = weight === 2 ? 9 : weight - 1
    }
    const rest = sum % 11
    const check = rest < 2 ? 0 : 11 - rest
    if (check !== digits[position]) return false
  }
  return true
}

/**
 * Valor casa com a máscara? Padrão técnico da casa (decisão 16):
 * `#` = dígito, `A` = letra, qualquer outro caractere é literal obrigatório.
 * Ex.: matchesMask('(##) #-####-####', '(31) 9-8888-7777') === true.
 * Máscara vazia/nula = sem restrição.
 */
export function matchesMask(mask: string | null | undefined, value: string): boolean {
  if (!mask) return true
  if (mask.length !== value.length) return false
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i]
    const c = value[i]
    if (m === '#') { if (!/\d/.test(c)) return false }
    else if (m === 'A') { if (!/[a-zA-ZÀ-ÿ]/.test(c)) return false }
    else if (m !== c) return false
  }
  return true
}

/** Remove tudo que não é dígito (para normalizar entradas legadas). */
export function stripNonDigits(value: string): string {
  return value.replace(/\D/g, '')
}
