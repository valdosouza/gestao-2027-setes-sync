import { z } from 'zod'

/** Schema Zod de REDE SOCIAL — peça independente (SRP/ISP). */
export const socialMediaBody = z.object({
  kind: z.string().min(1).max(50),
  link: z.string().max(100).nullable().optional(),
})
