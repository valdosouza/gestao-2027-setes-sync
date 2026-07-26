import { z } from 'zod'

/** Schema Zod da ENTITY BASE (tb_entity) — SÓ tb_entity (SRP). */

const dateRe = /^\d{4}-\d{2}-\d{2}$/

export const entityBody = z.object({
  nameCompany: z.string().min(1).max(100),
  nickTrade:   z.string().min(1).max(100),
  aniversary:  z.string().regex(dateRe).nullable().optional(),
})
