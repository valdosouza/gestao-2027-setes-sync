import { z } from 'zod'
import { isValidCpf, isValidCnpj } from '../validation'

/**
 * Schemas Zod FISCAIS (PF/PJ) — peça independente (SRP/ISP).
 * CPF/CNPJ chegam SEM máscara (decisão 19) e com dígito verificador
 * validado (decisão do Valdo, Rodada 3 — Fase 2 campos configuráveis).
 */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

// Legado manda data VAZIA ('') quando não preenchida — 1ª rodada real
// 2026-07-27: 70 clientes barrados por company.dtFoundation ''. Vazio = null.
const optionalDate = z.preprocess(
  v => (v === '' ? null : v),
  z.string().regex(dateRe).nullable().optional()
)

export const personBody = z.object({
  cpf:      z.string().regex(/^\d{11}$/, 'CPF deve ter 11 dígitos numéricos, sem máscara')
             .refine(isValidCpf, 'CPF inválido (dígito verificador não confere)'),
  rg:       z.string().max(20).nullable().optional(),
  birthday: optionalDate,
})

export const companyBody = z.object({
  cnpj:         z.string().regex(/^\d{14}$/, 'CNPJ deve ter 14 dígitos numéricos, sem máscara')
                 .refine(isValidCnpj, 'CNPJ inválido (dígito verificador não confere)'),
  ie:           z.string().max(45).nullable().optional(),
  im:           z.string().max(45).nullable().optional(),
  dtFoundation: optionalDate,
})
