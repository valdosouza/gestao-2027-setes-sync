import { z } from 'zod'

/**
 * Schema Zod de FONE — peça independente (SRP/ISP).
 * number SEM máscara (decisão 19): somente dígitos; a máscara é só de
 * digitação/exibição no app.
 */
export const phoneBody = z.object({
  kind:    z.string().min(1).max(20),
  contact: z.string().max(100).nullable().optional(),
  number:  z.string().max(20).regex(/^\d*$/, 'Fone deve conter somente dígitos, sem máscara')
            .nullable().optional(),
})
