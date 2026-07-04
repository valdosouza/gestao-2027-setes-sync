/**
 * @swagger
 * /brand/sincronize:
 *   post:
 *     summary: Sincronizar Marcas
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               brands:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     name: { type: string }
 *     responses:
 *       200: { description: Sucesso, content: { application/json: { schema: { $ref: '#/components/schemas/SyncResponse' } } } }
 *       401: { description: X-Api-Key inválida }
 *       500: { description: Erro ao processar }
 *
 * /customer/sincronize:
 *   post:
 *     summary: Sincronizar Clientes
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               customers:
 *                 type: array
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /financial/sincronize:
 *   post:
 *     summary: Sincronizar Dados Financeiros
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               financials:
 *                 type: array
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /category/sincronize:
 *   post:
 *     summary: Sincronizar Categorias
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /merchandise/sincronize:
 *   post:
 *     summary: Sincronizar Mercadorias
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /provider/sincronize:
 *   post:
 *     summary: Sincronizar Fornecedores
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /salesman/sincronize:
 *   post:
 *     summary: Sincronizar Vendedores
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /cashier/sincronize:
 *   post:
 *     summary: Sincronizar Caixas
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /bank-account/sincronize:
 *   post:
 *     summary: Sincronizar Contas Bancárias
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /payment-type/sincronize:
 *   post:
 *     summary: Sincronizar Tipos de Pagamento
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /stock-balance/sincronize:
 *   post:
 *     summary: Sincronizar Saldo de Estoque
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /stock-list/sincronize:
 *   post:
 *     summary: Sincronizar Lista de Estoque
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /order-sale/sincronize:
 *   post:
 *     summary: Sincronizar Pedidos de Venda
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /order-purchase/sincronize:
 *   post:
 *     summary: Sincronizar Pedidos de Compra
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /price/sincronize:
 *   post:
 *     summary: Sincronizar Preços
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /price-list/sincronize:
 *   post:
 *     summary: Sincronizar Listas de Preço
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /promotion/sincronize:
 *   post:
 *     summary: Sincronizar Promoções
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /financial-plans/sincronize:
 *   post:
 *     summary: Sincronizar Planos Financeiros
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /financial-statement/sincronize:
 *   post:
 *     summary: Sincronizar Extrato Financeiro
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /order-stock-adjust/sincronize:
 *   post:
 *     summary: Sincronizar Ajustes de Estoque
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /package/sincronize:
 *   post:
 *     summary: Sincronizar Pacotes
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /stock-statement/sincronize:
 *   post:
 *     summary: Sincronizar Demonstrativo de Estoque
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 *
 * /file-xml/sincronize:
 *   post:
 *     summary: Sincronizar Arquivos XML
 *     tags: [Sincronização]
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 */

// Este arquivo contém apenas documentação Swagger dos endpoints
// Importar em src/app.ts para incluir na documentação
export const endpointDocs = {}
