// Envelope padrão de resposta ao Sincronizador Delphi — decisão D14:
//   sucesso: { ok: true, id, externalCode? }
//   erro:    { ok: false, error }  (sempre com HTTP status <> 200 — o Delphi
//            marca sucesso pelo HTTP 200 e grava o erro em TB_SINCRONIA.SRC_LOG)
// externalCode: UUID devolvido quando a entidade não tem CPF/CNPJ (D4) — o
// Sincronizador grava em tb_empresa.externalCode no Firebird.
export interface SyncResponse {
  ok:            boolean
  id?:           number
  externalCode?: string
  error?:        string
}

export function syncSuccess(id: number, externalCode?: string): SyncResponse {
  const body: SyncResponse = { ok: true, id }
  if (externalCode) body.externalCode = externalCode
  return body
}

export function syncError(error: string): SyncResponse {
  return { ok: false, error }
}
