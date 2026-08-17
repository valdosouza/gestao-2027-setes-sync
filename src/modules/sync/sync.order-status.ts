import { z } from 'zod'

/**
 * STATUS DO PEDIDO — domínio da WEB × flag do legado (Valdo, 2026-08-14).
 *
 * O legado não tem status de processo: guarda em `TB_PEDIDO.PED_FATURADO` um
 * flag de FATURAMENTO — 'S' faturado / 'A' em aberto — e o Sincronizador o
 * mandava cru para `tb_order.status`. O domínio da web é o ESTADO DO PROCESSO:
 *   'F' = fechado   ← 'S' do legado (faturado encerra o processo)
 *   'A' = aberto    ← 'A' do legado (permanece)
 *
 * A tradução passou a ser feita no ENVIO (`invoice_send_web.pas`,
 * TInvoiceSendWeb.OrderStatus — "quem aposenta se adapta", D15/D22). Esta
 * normalização é a rede de TRANSIÇÃO: enquanto houver cliente rodando
 * executável antigo, o 'S' que chegar aqui vira 'F' do mesmo jeito — sem ela,
 * a base ficaria com os dois domínios misturados até a última compilação.
 * Mesmo espírito do fallback do bloco `user`; pode morrer quando todos os
 * clientes estiverem com o executável novo.
 *
 * Valor fora do domínio conhecido segue CRU (não se inventa estado) — o
 * varchar(1) da coluna é o único limite.
 */
export const orderStatusField = z
  // .trim() ANTES do .max(1): CHAR(1) do Firebird pode chegar com espaço e um
  // 400 por causa disso derrubaria a ordem inteira (mesma postura defensiva do
  // stripDocumentMasks — o contrato pede limpo, mas o legado escorrega).
  .string().trim().max(1).optional().nullable()
  .transform(v => (v?.toUpperCase() === 'S' ? 'F' : v))
