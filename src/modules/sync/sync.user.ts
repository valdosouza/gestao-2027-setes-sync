import { PoolConnection } from 'mysql2/promise'
import { z } from 'zod'
import { HttpError } from '@shared/errors/http-error'
import { findEntityIdByDocument } from './sync.entity'

/**
 * AUTOR das operações do legado (prompt_indexacao_usuario_firebird.md).
 * O usuário do Firebird (TB_USUARIO) vira entity + tb_user SEM credencial
 * na central (decisão 1) via /user/sincronize; os movimentos (pedidos,
 * caixa, extrato) referenciam o autor por DOCUMENTO ou externalCode — o
 * código local (USU_CODIGO) NUNCA viaja (D3). Aqui só se RESOLVE a
 * referência; quem cria é o endpoint /user/sincronize.
 */

/** Bloco `user` dos movimentos: exatamente UMA das duas referências. */
export const userRefBody = z.object({
  userDocument:     z.string().trim().min(11).max(18).optional(),
  userExternalCode: z.string().uuid().optional(),
}).refine(u => (u.userDocument !== undefined) !== (u.userExternalCode !== undefined), {
  message: 'informe userDocument OU userExternalCode (exatamente um)',
})

export type UserRef = z.infer<typeof userRefBody>

/**
 * Resolve o bloco `user` para o tb_user.id (= entity.id) na central.
 * Exige tb_user + vínculo tb_institution_has_user — ambos nascem no
 * /user/sincronize; ausência = 409 USER_NOT_SYNCED (auto-heal no próximo
 * ciclo, como os demais *_NOT_SYNCED).
 */
export async function resolveUserId(
  conn: PoolConnection, ref: UserRef, institutionId: number
): Promise<number> {
  let entityId: number | null = null
  if (ref.userDocument) {
    entityId = await findEntityIdByDocument(conn, ref.userDocument)
  } else if (ref.userExternalCode) {
    const [rows] = await conn.query<any[]>(
      `SELECT id FROM setes_central.tb_no_doc WHERE external_id = ? AND deleted = 'N' LIMIT 1`,
      [ref.userExternalCode]
    )
    entityId = rows.length ? Number(rows[0].id) : null
  }
  if (entityId !== null) {
    const [rows] = await conn.query<any[]>(
      `SELECT u.id FROM setes_central.tb_user u
       JOIN setes_central.tb_institution_has_user ihu
         ON ihu.tb_user_id = u.id AND ihu.tb_institution_id = ? AND ihu.deleted = 'N'
       WHERE u.id = ? LIMIT 1`,
      [institutionId, entityId]
    )
    if (rows.length) return entityId
  }
  const refStr = ref.userDocument ?? ref.userExternalCode
  throw new HttpError(409, `Usuário ${refStr} ainda não sincronizado`,
    [{ field: 'user', message: 'sincronize o usuário antes — reenvio no próximo ciclo' }],
    'USER_NOT_SYNCED')
}

/**
 * Fallback de TRANSIÇÃO (decisão 5): payload sem o bloco `user`
 * (sincronizador antigo ou PDV sem documento — decisão 8) assina com o
 * usuário mais antigo do institution. Morte do fallback = Rodada 4,
 * quando todos os clientes estiverem no executável novo.
 */
export async function resolveFallbackUserId(
  conn: PoolConnection, institutionId: number
): Promise<number> {
  const [rows] = await conn.query<any[]>(
    `SELECT MIN(tb_user_id) AS uid FROM setes_central.tb_institution_has_user
     WHERE tb_institution_id = ? AND deleted = 'N'`,
    [institutionId]
  )
  const uid = rows[0]?.uid
  if (!uid) {
    throw new HttpError(409, 'Institution sem usuário para assinar o movimento',
      [{ field: 'id', message: 'cadastre um usuário do institution antes — reenvio no próximo ciclo' }],
      'INSTITUTION_USER_NOT_FOUND')
  }
  return Number(uid)
}
