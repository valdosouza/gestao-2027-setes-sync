# Guia de Setup — setes-sync

## Pré-requisitos

- Node.js 18+
- npm ou yarn
- MySQL 5.7+
- Sincronizador Delphi (rodando)

---

## 1️⃣ Instalação

```bash
cd D:\Gestao2027\setes-sync
npm install
```

**Output esperado**:
```
up to date, audited XXX packages
```

---

## 2️⃣ Configuração de Ambiente

Copie `.env.example` para `.env` e ajuste:

```bash
# Windows
copy .env.example .env
```

**Conteúdo de `.env`**:
```
PORT=3001
SYNC_API_KEY=sua_chave_compartilhada_do_sincronizador_aqui
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=senha
DB_NAME=setes_central
```

⚠️ **IMPORTANTE**: A `SYNC_API_KEY` deve ser a MESMA que está configurada no Sincronizador Delphi.

---

## 3️⃣ Iniciar setes-sync

```bash
npm run dev
```

**Output esperado**:
```
[INFO]  2026-07-01T15:30:00.000Z Setes Sync API rodando na porta 3001
```

Agora a API está disponível em: `http://localhost:3001`

---

## 4️⃣ Validar Health Check

```bash
curl http://localhost:3001/health
```

**Resposta esperada**:
```json
{
  "status": "ok",
  "service": "setes-sync",
  "ts": "2026-07-01T15:30:05.123Z"
}
```

---

## 5️⃣ Testar com Sincronizador Delphi

### Opção A: Teste Manual (curl)

**1. Testar /brand/sincronize**

```bash
curl -X POST http://localhost:3001/brand/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: sua_chave_compartilhada_do_sincronizador_aqui" \
  -d '{
    "brands": [
      {"id": "1", "name": "Brand A", "active": true},
      {"id": "2", "name": "Brand B", "active": false}
    ]
  }'
```

**Resposta esperada (200)**:
```json
{
  "ok": true,
  "inserted": 2,
  "updated": 0,
  "errors": 0,
  "message": "Sincronização concluída"
}
```

**2. Testar /customer/sincronize**

```bash
curl -X POST http://localhost:3001/customer/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: sua_chave_compartilhada_do_sincronizador_aqui" \
  -d '{
    "customers": [
      {"id": "CLI-001", "name": "Cliente A", "email": "a@example.com"}
    ]
  }'
```

**3. Testar /stock-balance/sincronize**

```bash
curl -X POST http://localhost:3001/stock-balance/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: sua_chave_compartilhada_do_sincronizador_aqui" \
  -d '{
    "stockBalances": [
      {"id": "1", "quantity": 100, "productId": "P001"}
    ]
  }'
```

### Opção B: Configurar Sincronizador para Enviar Dados

No Sincronizador Delphi, configure:
1. Endpoint: `http://localhost:3001/<recurso>/sincronize`
2. Header: `X-Api-Key: sua_chave_compartilhada_do_sincronizador_aqui`
3. Method: POST
4. Inicie sincronização

---

## 6️⃣ Testes de Erro

### Teste sem X-Api-Key

```bash
curl -X POST http://localhost:3001/brand/sincronize \
  -H "Content-Type: application/json" \
  -d '{"brands": []}'
```

**Resposta esperada (401)**:
```json
{
  "error": "X-Api-Key header obrigatorio"
}
```

### Teste com X-Api-Key inválida

```bash
curl -X POST http://localhost:3001/brand/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: chave_errada" \
  -d '{"brands": []}'
```

**Resposta esperada (401)**:
```json
{
  "error": "API Key invalida"
}
```

### Teste com payload vazio

```bash
curl -X POST http://localhost:3001/brand/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: sua_chave_compartilhada_do_sincronizador_aqui" \
  -d '{}'
```

**Resposta esperada (400 ou 500)**: Erro de validação

---

## 7️⃣ Monitorar Logs

**Logs em tempo real**:
```bash
# Terminal rodando setes-sync já mostra os logs
# Procure por:
# [INFO] Sincronizador autenticado
# [ERROR] se houver erros
```

---

## 8️⃣ Verificar Dados no Banco

```sql
-- Conectar ao MySQL
mysql -u root -p setes_central

-- Ver logs de sincronização
SELECT * FROM sync_log ORDER BY created_at DESC LIMIT 10;

-- Ver dados sincronizados em um schema
USE schema_tenant_001;
SELECT * FROM tb_brand;
SELECT * FROM tb_customer;
```

---

## 9️⃣ Troubleshooting

### Erro: "Port 3001 already in use"
```bash
# Windows: Kill processo na porta 3001
netstat -ano | findstr :3001
taskkill /PID <PID> /F

# Linux/Mac:
lsof -i :3001
kill -9 <PID>
```

### Erro: "Cannot find module '@shared/db/connection'"
```bash
# Verificar tsconfig.json paths
# Executar: npm install
# Reiniciar: npm run dev
```

### Erro: "Access denied for user 'root'@'localhost'"
```bash
# Verificar .env:
# DB_USER=root
# DB_PASSWORD=<sua_senha>
# DB_HOST=localhost
```

### API Key inválida mesmo com chave certa
- Verificar se a chave está configurada em `setes_central.sync_api_keys`
- Verificar se `active = TRUE` no banco
- Limpar cache (reiniciar setes-sync)

---

## 🔟 Checklist de Validação

- [ ] `npm install` executado
- [ ] `.env` criado e configurado
- [ ] `npm run dev` rodando sem erros
- [ ] GET `/health` retorna 200
- [ ] POST `/brand/sincronize` com X-Api-Key válida retorna 200
- [ ] POST sem X-Api-Key retorna 401
- [ ] Dados aparecem no banco após sincronização
- [ ] Sincronizador Delphi consegue conectar

---

## Próximos Passos

1. ✅ Setup local concluído
2. ⏳ Integrar Sincronizador Delphi
3. ⏳ Validar setes-api (Tarefa #6)
4. ⏳ Documentar arquitetura (Tarefa #7)

