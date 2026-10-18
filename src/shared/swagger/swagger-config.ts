import swaggerJsdoc from 'swagger-jsdoc'

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Setes Sync API',
      version: '1.0.0',
      description: 'API de sincronização de dados do Sincronizador Delphi para Gestao 2027',
      contact: {
        name: 'Setes',
        url: 'https://www.setes.com.br',
        email: 'valdo@setes.com.br',
      },
    },
    servers: [
      {
        url: 'http://localhost:3001',
        description: 'Development server',
      },
      {
        url: 'https://api.setes.com.br/sync',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description:
            'API Key da instalação (setes_central.tb_sync_api_key — D12). Recusas em TODO /sincronize ' +
            '(D-SY13): 401 SYNC_KEY_MISSING (header ausente), 401 SYNC_KEY_INVALID (chave inexistente), ' +
            '403 SYNC_KEY_INACTIVE (chave existente e inativa). O Sincronizador para a sincronia sem marcar ' +
            'o SRC_LOG e fica inativo até o usuário ativar (consulta em GET /sync-key/status). A chave válida ' +
            'fica em cache 5 min no processo (limite conhecido: desativar vale em até 5 min).',
        },
      },
      schemas: {
        SyncResponse: {
          type: 'object',
          properties: {
            ok: {
              type: 'boolean',
              example: true,
            },
            inserted: {
              type: 'integer',
              example: 10,
            },
            updated: {
              type: 'integer',
              example: 5,
            },
            errors: {
              type: 'integer',
              example: 0,
            },
            message: {
              type: 'string',
              example: 'Sincronização concluída',
            },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              example: 'X-Api-Key header obrigatorio',
            },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              example: 'ok',
            },
            service: {
              type: 'string',
              example: 'setes-sync',
            },
            ts: {
              type: 'string',
              format: 'date-time',
              example: '2026-07-01T15:30:00.000Z',
            },
          },
        },
      },
    },
    security: [
      {
        ApiKeyAuth: [],
      },
    ],
  },
  // Revisão do sincronizador (Onda 5): cada endpoint carrega o próprio bloco
  // @swagger no arquivo — o swagger-endpoints.ts legado (docs centralizadas e
  // defasadas) foi aposentado. Só o que está nestes globs aparece no /docs.
  apis: ['./src/app.ts', './src/modules/sync/endpoints/*.ts'],
}

export const swaggerSpec = swaggerJsdoc(options)
