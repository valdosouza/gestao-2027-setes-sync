import { z } from 'zod'

/** Schema Zod de ENDEREÇO — peça independente (SRP/ISP). */
export const addressBody = z.object({
  kind:         z.string().min(1).max(100),
  street:       z.string().min(1).max(100),
  nmbr:         z.string().max(10).nullable().optional(),
  complement:   z.string().max(100).nullable().optional(),
  neighborhood: z.string().max(100).nullable().optional(),
  // SEM máscara (decisão 19): somente dígitos; máscara só na digitação/exibição.
  zipCode:      z.string().max(15).regex(/^\d*$/, 'CEP deve conter somente dígitos, sem máscara')
                 .nullable().optional(),
  tbCountryId:  z.number().int().positive(),
  tbStateId:    z.number().int().positive(),
  tbCityId:     z.number().int().positive(),
  main:         z.enum(['S', 'N']).optional(),
})
