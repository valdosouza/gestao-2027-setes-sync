# CLAUDE.md

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md`
(documentação, skills, agentes e decisões arquiteturais vigentes). Em especial:
- Banco de dados: `Infra-IA/database/PADROES_BANCO.md` + skill `revisar-ddl.md` (obrigatório antes de DDL)
- Decisões vigentes (Fase 2): `Infra-IA/setes-api/prompt_fase2_gerenciamento_central.md` — JWT usa
  `institutionId` int (nunca `tenantId`), tabelas `tb_institution`/`tb_feature_flag`/`tb_sync_api_key`,
  schemas `setes_<nome>`.
Ao concluir tarefa que gere conhecimento novo, siga `Infra-IA/skills-genericas/atualizar-infra-ia.md`.



This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

```bash
# Development
npm run dev                 # Start with hot reload (tsx watch on port 3001)
npm run build              # Build TypeScript to dist/
npm start                  # Run compiled JavaScript

# Testing
npm test                   # Run all tests
npm test -- specific.test  # Run specific test file
```

## Architecture Overview

**setes-sync** is a dedicated synchronization API for receiving data from the Sincronizador Delphi system.

### Request Flow

```
Sincronizador.exe (Delphi)
    ↓
POST /brand/sincronize + X-Api-Key
    ↓
[authMiddleware] — validates X-Api-Key
    ↓
[rateLimitMiddleware] — 500 req/min
    ↓
[syncRoutes] → Process & store in MySQL
    ↓
Response: {ok: true, inserted: 100, errors: 0}
```

## Code Structure

```
src/
├── gateway/
│   ├── auth.middleware.ts          # X-Api-Key validation
│   ├── rate-limit.middleware.ts    # 500 req/min limit
│   └── router.ts                   # Routes registration
├── modules/
│   └── sync/
│       ├── endpoints/              # One file per data type (to be migrated from setes-api)
│       │   ├── brand.ts
│       │   ├── customer.ts
│       │   └── ... (28 more)
│       └── sync.routes.ts          # Route registration
├── shared/
│   ├── db/connection.ts            # MySQL pool (per-schema)
│   ├── errors/http-error.ts        # Custom error class
│   ├── logger/logger.ts            # Console logger
│   └── types/express.d.ts          # TypeScript augmentation for req.syncContext
├── app.ts                          # Express configuration
└── server.ts                       # Bootstrap
```

## Authentication

### X-Api-Key (Sincronizador Only)

All endpoints require X-Api-Key header:
```
X-Api-Key: <shared_secret>
```

**Validation**:
- Header must be present
- Must match `SYNC_API_KEY` in `.env`
- Returns 401 if invalid

**Special case**: GET /health is open (no auth required)

## Sync Endpoints (30 types)

Each endpoint follows this pattern:

```typescript
POST /<resource>/sincronize
Content-Type: application/json
X-Api-Key: <key>

{
  "<resource>s": [
    { id: "1", name: "Value 1", ... },
    { id: "2", name: "Value 2", ... }
  ]
}

Response:
{
  ok: true,
  inserted: 2,
  updated: 0,
  errors: 0,
  message: "Sincronização concluída"
}
```

### Available Endpoints

```
POST /brand/sincronize
POST /customer/sincronize
POST /financial/sincronize
POST /category/sincronize
POST /merchandise/sincronize
POST /provider/sincronize
POST /salesman/sincronize
POST /cashier/sincronize
POST /bank-account/sincronize
POST /payment-type/sincronize
POST /stock-balance/sincronize
POST /stock-list/sincronize
POST /order-sale/sincronize
POST /order-purchase/sincronize
POST /price/sincronize
POST /price-list/sincronize
POST /promotion/sincronize
POST /financial-plans/sincronize
POST /financial-statement/sincronize
POST /order-stock-adjust/sincronize
POST /package/sincronize
POST /rest-group/sincronize
POST /rest-subgroup/sincronize
POST /rest-menu/sincronize
POST /stock-statement/sincronize
POST /filexml/sincronize
+ 4 more restaurant-specific endpoints
```

## Environment Variables

```bash
PORT=3001                                           # API port
SYNC_API_KEY=sua_chave_compartilhada_aqui          # Shared secret with Sincronizador
DB_HOST=localhost                                   # MySQL host
DB_PORT=3306                                        # MySQL port
DB_USER=root                                        # DB user
DB_PASSWORD=password                                # DB password
DB_NAME=setes_central                              # Central database
```

## Multi-Tenant & Database Schemas

Each client has its own MySQL schema (e.g., `schema_tenant_001`, `schema_beta`).

**How it works**:
- Sincronizador sends `tenantId` in payload (if applicable)
- setes-sync determines target schema
- Data stored in `schema_tenant_XXX`
- Central logs stored in `setes_central`

## Rate Limiting

- **Window**: 60 seconds
- **Max requests**: 500 per minute
- **Per**: IP address (shared connection from Sincronizador)

## Integration with setes-api

After sync:
- Data is stored in tenant schemas
- setes-api reads via `/api/core/info`, `/api/erp/status`, etc.
- setes-app consumes via JWT

```
Sincronizador → setes-sync:3001 → setes_central (logs + data)
                                   ↓
                            setes-api:3000 (reads)
                                   ↓
                            setes-app (consumes)
```

## Testing Notes

- Jest configured with path alias mapping
- Tests use `supertest` for HTTP assertions
- X-Api-Key header required in all test requests

Example test:
```typescript
import request from 'supertest'
import app from '../app'

describe('POST /brand/sincronize', () => {
  it('returns 401 without X-Api-Key', async () => {
    const res = await request(app).post('/brand/sincronize').send({})
    expect(res.status).toBe(401)
  })

  it('stores brands with valid X-Api-Key', async () => {
    const res = await request(app)
      .post('/brand/sincronize')
      .set('X-Api-Key', process.env.SYNC_API_KEY!)
      .send({ brands: [{ id: '1', name: 'Brand A' }] })
    expect(res.status).toBe(200)
    expect(res.body.inserted).toBe(1)
  })
})
```

## Common Workflows

**Adding a new sync endpoint**:
1. Create `src/modules/sync/endpoints/[resource].ts`
2. Implement repository query in `[resource].repository.ts`
3. Add service logic in `[resource].service.ts`
4. Register route in `src/modules/sync/sync.routes.ts`
5. Update documentation with new endpoint

**Debugging sync failures**:
- Check `src/shared/logger/logger.ts` for middleware logs
- Verify X-Api-Key matches environment variable
- Check rate limit hasn't been exceeded
- Query `setes_central.sync_logs` for error details

## Key Files to Know

| File | Purpose |
|------|---------|
| `src/app.ts` | Express setup, middleware order, health check |
| `src/gateway/auth.middleware.ts` | X-Api-Key validation |
| `src/modules/sync/sync.routes.ts` | All 30 endpoint registrations |
| `src/shared/db/connection.ts` | MySQL pool and schema switching |
| `src/shared/types/express.d.ts` | `req.syncContext` type definition |
| `.env.example` | Environment template |

## Deployment Notes

- Port: 3001 (separate from setes-api:3000)
- Health check: GET /health (no auth, returns `{status: "ok", service: "setes-sync", ts: "..."}`)
- All other endpoints require X-Api-Key header
- Database: Shared `setes_central`, per-client schemas for data
