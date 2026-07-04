# Swagger Documentation — setes-sync

## Acessar Documentação Interativa

Depois de iniciar a API:

```bash
npm run dev
```

Abra no navegador:

```
http://localhost:3001/docs
```

Você verá a documentação interativa do Swagger UI com todos os endpoints.

---

## Arquitetura de Documentação

### Configuração

- **`src/shared/swagger/swagger-config.ts`** — Definição OpenAPI 3.0, servidores, esquemas
- **`src/shared/swagger/swagger-endpoints.ts`** — Documentação de todos os 23 endpoints
- **`src/app.ts`** — Integração com Express (rota `/docs`)

### Como Funciona

1. Swagger JSDoc escaneia arquivos em `src/shared/swagger/swagger-endpoints.ts`
2. Combina com definição em `swagger-config.ts`
3. Gera especificação OpenAPI 3.0
4. Swagger UI renderiza em `/docs`

---

## 23 Endpoints Documentados

### Sincronização de Dados Mestres

```
POST /brand/sincronize              → Marcas
POST /customer/sincronize           → Clientes
POST /category/sincronize           → Categorias
POST /merchandise/sincronize        → Mercadorias
POST /provider/sincronize           → Fornecedores
POST /salesman/sincronize           → Vendedores
```

### Operações Financeiras

```
POST /financial/sincronize          → Dados Financeiros
POST /financial-plans/sincronize    → Planos Financeiros
POST /financial-statement/sincronize → Extrato Financeiro
```

### Gestão de Estoque

```
POST /stock-balance/sincronize      → Saldo de Estoque
POST /stock-list/sincronize         → Lista de Estoque
POST /stock-statement/sincronize    → Demonstrativo de Estoque
POST /order-stock-adjust/sincronize → Ajustes de Estoque
```

### Operações de Venda e Compra

```
POST /order-sale/sincronize         → Pedidos de Venda
POST /order-purchase/sincronize     → Pedidos de Compra
```

### Precificação

```
POST /price/sincronize              → Preços
POST /price-list/sincronize         → Listas de Preço
POST /promotion/sincronize          → Promoções
```

### Operações Gerais

```
POST /cashier/sincronize            → Caixas
POST /bank-account/sincronize       → Contas Bancárias
POST /payment-type/sincronize       → Tipos de Pagamento
POST /package/sincronize            → Pacotes
POST /file-xml/sincronize           → Arquivos XML
```

---

## Autenticação

Todos os endpoints (exceto `/health` e `/docs`) requerem:

```
X-Api-Key: sua_chave_compartilhada_do_sincronizador
```

No Swagger UI, você pode adicionar a chave:
1. Clique no botão "Authorize" (cadeado no topo)
2. Digite sua chave em `X-Api-Key`
3. Clique "Authorize"
4. Agora todos os testes incluem a autenticação

---

## Testar Endpoints no Swagger

### 1. Clique em um endpoint

Ex: `POST /brand/sincronize`

### 2. Clique em "Try it out"

### 3. Edite o Request Body (JSON)

Exemplo:
```json
{
  "brands": [
    {
      "id": 1,
      "name": "Nike"
    },
    {
      "id": 2,
      "name": "Adidas"
    }
  ]
}
```

### 4. Clique em "Execute"

### 5. Veja a resposta

```json
{
  "ok": true,
  "inserted": 2,
  "updated": 0,
  "errors": 0,
  "message": "Sincronização concluída"
}
```

---

## Respostas Padronizadas

### Sucesso (200)

```json
{
  "ok": true,
  "inserted": 10,
  "updated": 5,
  "errors": 0,
  "message": "Sincronização concluída"
}
```

### Erro de Autenticação (401)

```json
{
  "error": "X-Api-Key header obrigatorio"
}
```

ou

```json
{
  "error": "API Key invalida"
}
```

### Erro Interno (500)

```json
{
  "error": "Erro ao processar sincronização"
}
```

---

## Explorar Especificação OpenAPI

### JSON Raw

```
http://localhost:3001/docs.json
```

Retorna a especificação OpenAPI 3.0 em JSON (útil para gerar clientes em outras linguagens).

### Ferramentas Compatíveis

A especificação OpenAPI pode ser usada com:

- **Postman** — Importar URL: `http://localhost:3001/docs.json`
- **Insomnia** — Importar URL
- **ReDoc** — Documentação alternativa
- **Code Generators** — Gerar SDKs (Python, Java, Go, etc)

---

## Exemplos de Uso

### cURL

```bash
curl -X POST http://localhost:3001/brand/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: sua_chave" \
  -d '{
    "brands": [
      {"id": 1, "name": "Nike"}
    ]
  }'
```

### Postman

1. Importar: `http://localhost:3001/docs.json`
2. Configurar variável `X-Api-Key`
3. Testar cada endpoint

### Python (usando openapi-generator)

```bash
openapi-generator-cli generate \
  -i http://localhost:3001/docs.json \
  -g python \
  -o ./setes-sync-client-python
```

---

## Deploy em Produção

### Alterar servidor no Swagger

Em `src/shared/swagger/swagger-config.ts`, atualize:

```typescript
servers: [
  {
    url: 'http://localhost:3001',
    description: 'Development server',
  },
  {
    url: 'https://sync.setes.com.br',  // ← Adicione seu domínio
    description: 'Production server',
  },
],
```

### Desabilitar Swagger em Produção (Segurança)

Opcional, em `src/app.ts`:

```typescript
if (process.env.NODE_ENV !== 'production') {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))
}
```

---

## Atualizar Documentação

### Para adicionar novo endpoint:

1. Adicione documentação JSDoc em `src/shared/swagger/swagger-endpoints.ts`
2. Restart servidor
3. Acesse `http://localhost:3001/docs` para ver atualização

### Formato JSDoc:

```typescript
/**
 * @swagger
 * /seu-endpoint/sincronize:
 *   post:
 *     summary: Descrição breve
 *     tags: [Sincronização]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: Sucesso }
 *       401: { description: X-Api-Key inválida }
 */
```

---

## Referências

- **Swagger UI**: https://swagger.io/tools/swagger-ui/
- **OpenAPI 3.0**: https://spec.openapis.org/oas/v3.0.3
- **Swagger JSDoc**: https://www.npmjs.com/package/swagger-jsdoc

