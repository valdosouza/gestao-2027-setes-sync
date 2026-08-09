#!/usr/bin/env node

/**
 * Test Sync CLI — Orquestrador de testes do Sincronizador
 *
 * Uso:
 *   npx ts-node scripts/test-sync-cli.ts --round 1 --user valdo@setes.com.br
 *   npx ts-node scripts/test-sync-cli.ts --session abc123 --resume
 *   npx ts-node scripts/test-sync-cli.ts --report abc123
 */

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const API_BASE_URL = process.env.API_URL || 'http://localhost:3001';

/**
 * X-Api-Key para os endpoints /<recurso>/sincronize.
 * Ordem: env SYNC_API_KEY → arquivo .dev-sync-key na raiz do projeto.
 */
function loadSyncApiKey(): string {
  if (process.env.SYNC_API_KEY) return process.env.SYNC_API_KEY;
  const keyFile = path.join(process.cwd(), '.dev-sync-key');
  if (fs.existsSync(keyFile)) {
    return fs.readFileSync(keyFile, 'utf-8').trim();
  }
  return '';
}

const SYNC_API_KEY = loadSyncApiKey();

interface TestLog {
  table: string;
  endpoint: string;
  status: 'success' | 'failed' | 'reset' | 'pending';
  registros_esperados: number;
  registros_enviados: number;
  erro_mensagem?: string;
  tempo_segundos?: number;
}

interface TestSession {
  id: string;
  usuario: string;
  round: number;
  status: 'em_andamento' | 'parado' | 'concluido';
  logs: TestLog[];
  timestamp_inicio: string;
  timestamp_fim?: string;
}

class TestSyncCLI {
  private sessionId: string = '';
  private sessionFile: string = path.join(process.cwd(), '.test-session');

  /**
   * Criar nova sessão de testes
   */
  async createSession(usuario: string, round: number): Promise<void> {
    try {
      console.log(`📋 Criando sessão para ${usuario} (Round ${round})...`);

      const response = await axios.post(`${API_BASE_URL}/api/test/sessions`, {
        usuario,
        observacoes: `Round ${round} — Testes incrementais`,
      });

      const sessionId = response.data.session_id;
      this.sessionId = sessionId;

      // Salvar sessão localmente
      const session: TestSession = {
        id: sessionId,
        usuario,
        round,
        status: 'em_andamento',
        logs: [],
        timestamp_inicio: new Date().toISOString(),
      };

      fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2));

      console.log(`✅ Sessão criada: ${sessionId}`);
      console.log(`📝 Salvo em: ${this.sessionFile}`);
    } catch (error) {
      this.handleError('createSession', error);
    }
  }

  /**
   * Carregar mapa de dependências
   */
  async loadDependencyMap() {
    try {
      console.log(`🗺️  Carregando mapa de dependências...`);

      const response = await axios.get(`${API_BASE_URL}/api/test/dependency-map`);
      const map = response.data as Array<{
        level: number;
        table_name: string;
        endpoint: string;
      }>;

      // Agrupar por level
      const byLevel = new Map<number, typeof map>();
      for (const item of map) {
        if (!byLevel.has(item.level)) {
          byLevel.set(item.level, []);
        }
        byLevel.get(item.level)!.push(item);
      }

      // Exibir
      for (let level = 0; level <= 7; level++) {
        const tables = byLevel.get(level) || [];
        if (tables.length === 0) continue;

        console.log(`\n📦 LEVEL ${level} (${tables.length} tabelas):`);
        for (const table of tables) {
          console.log(`  • ${table.table_name.padEnd(25)} → ${table.endpoint}`);
        }
      }

      return map;
    } catch (error) {
      this.handleError('loadDependencyMap', error);
    }
  }

  /**
   * Executar testes de um level
   */
  async runLevel(
    level: number,
    registrosCounts: Map<string, number>,
  ): Promise<boolean> {
    try {
      const map = await this.loadDependencyMap();
      const tables = map.filter((t) => t.level === level);

      console.log(`\n🚀 Executando Level ${level}...`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      let successCount = 0;
      let failureCount = 0;

      for (const table of tables) {
        const registros = registrosCounts.get(table.table_name) || 0;

        console.log(`⏳ ${table.table_name}...`);

        try {
          // Registrar início
          await axios.post(
            `${API_BASE_URL}/api/test/sessions/${this.sessionId}/tables/${table.table_name}/start`,
            {
              registros_esperados: registros,
            },
          );

          // Executar sincronização (chama endpoint real, com X-Api-Key)
          const startTime = Date.now();
          await axios.post(
            `${API_BASE_URL}${table.endpoint}`,
            {},
            { headers: { 'X-Api-Key': SYNC_API_KEY } },
          );
          const duration = (Date.now() - startTime) / 1000;

          // Registrar sucesso
          await axios.post(
            `${API_BASE_URL}/api/test/sessions/${this.sessionId}/tables/${table.table_name}/finish`,
            {
              status: 'success',
              registros_enviados: registros,
            },
          );

          console.log(`   ✅ ${registros} registros enviados (${duration.toFixed(2)}s)\n`);
          successCount++;
        } catch (error) {
          const errorMsg = this.extractErrorMessage(error);
          console.log(`   ❌ FALHA: ${errorMsg}\n`);

          // Registrar erro
          await axios.post(
            `${API_BASE_URL}/api/test/sessions/${this.sessionId}/tables/${table.table_name}/finish`,
            {
              status: 'failed',
              registros_enviados: 0,
              erro_mensagem: errorMsg,
            },
          );

          failureCount++;

          // PARAR EM ERRO
          console.log(`\n⚠️  TESTE PARADO EM ${table.table_name}`);
          console.log(`📋 Session: ${this.sessionId}`);
          console.log(`\nDiagnostique com:`);
          console.log(
            `  curl http://localhost:3001/api/test/sessions/${this.sessionId}/errors\n`,
          );

          return false;
        }
      }

      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📊 Level ${level}: ${successCount} ✓ / ${failureCount} ✗\n`);

      return failureCount === 0;
    } catch (error) {
      this.handleError('runLevel', error);
      return false;
    }
  }

  /**
   * Obter status da sessão
   */
  async getStatus(): Promise<void> {
    if (!this.sessionId) {
      console.error('❌ Nenhuma sessão ativa. Use --create ou --session.');
      process.exit(1);
    }

    try {
      const response = await axios.get(
        `${API_BASE_URL}/api/test/sessions/${this.sessionId}`,
      );

      const session = response.data.session;
      const summary = response.data.summary;

      console.log(`\n📋 Sessão: ${this.sessionId}`);
      console.log(`Usuário: ${session.usuario}`);
      console.log(`Status: ${session.status}`);
      console.log(`Início: ${session.iniciadp_em}`);
      if (session.finalizado_em) {
        console.log(`Fim: ${session.finalizado_em}`);
      }

      console.log(`\n📊 Resumo:`);
      console.log(`  Total: ${summary.total}`);
      console.log(`  ✓ Sucesso: ${summary.succeeded}`);
      console.log(`  ✗ Falha: ${summary.failed}`);
      console.log(`  ⏳ Pendente: ${summary.pending}`);

      console.log(`\n📈 Por Level:`);
      for (let level = 0; level <= 7; level++) {
        const stats = summary.by_level[level];
        if (!stats) continue;
        console.log(
          `  Level ${level}: ${stats.succeeded}/${stats.total} (${stats.failed} erros)`,
        );
      }
    } catch (error) {
      this.handleError('getStatus', error);
    }
  }

  /**
   * Gerar relatório final
   */
  async generateReport(): Promise<void> {
    if (!this.sessionId) {
      console.error('❌ Nenhuma sessão ativa.');
      process.exit(1);
    }

    try {
      console.log(`📊 Gerando relatório para ${this.sessionId}...\n`);

      const response = await axios.get(
        `${API_BASE_URL}/api/test/sessions/${this.sessionId}/report`,
      );

      const report = response.data;

      console.log(`╔════════════════════════════════════════════════════╗`);
      console.log(`║              RELATÓRIO DE TESTES                   ║`);
      console.log(`╚════════════════════════════════════════════════════╝`);

      console.log(`\nSessão: ${report.session_id}`);
      console.log(`Usuário: ${report.usuario}`);
      console.log(`Status: ${report.status}`);
      console.log(
        `Duração: ${report.duracao_minutos.toFixed(1)} minutos (${new Date(report.iniciado_em).toLocaleString()})\n`,
      );

      console.log(`📊 RESUMO:`);
      console.log(`  Total de tabelas: ${report.resumo.total_tabelas}`);
      console.log(`  ✅ Sucesso: ${report.resumo.sucesso}`);
      console.log(`  ❌ Falha: ${report.resumo.falha}`);
      console.log(`  ⏳ Aguardando: ${report.resumo.aguardando}\n`);

      if (report.detalhes.length > 0) {
        console.log(`📋 DETALHES:`);
        console.log(
          `${'Tabela'.padEnd(25)} | ${'Level'} | ${'Status'.padEnd(10)} | ${'Registros'.padEnd(15)} | ${'Tempo'}`,
        );
        console.log(`${'-'.repeat(25)}-+-${'-'.repeat(5)}-+-${'-'.repeat(10)}-+-${'-'.repeat(15)}-+-${'-'.repeat(8)}`);

        for (const detail of report.detalhes) {
          const status = detail.status === 'success' ? '✓ OK' : '✗ ERRO';
          const registros =
            `${detail.registros.enviados}/${detail.registros.esperados}`.padEnd(15);
          console.log(
            `${detail.table.padEnd(25)} | ${detail.level} | ${status.padEnd(10)} | ${registros} | ${detail.tempo_segundos.toFixed(2)}s`,
          );
        }
      }

      console.log(`\n✅ Relatório gerado com sucesso!`);
      console.log(`💾 Salve em Excel: curl http://localhost:3001/api/test/sessions/${this.sessionId}/logs > report.json`);
    } catch (error) {
      this.handleError('generateReport', error);
    }
  }

  /**
   * Resetar uma tabela e marcar para retry
   */
  async resetTable(tableName: string, approvedBy: string): Promise<void> {
    if (!this.sessionId) {
      console.error('❌ Nenhuma sessão ativa.');
      process.exit(1);
    }

    try {
      console.log(`🔄 Resetando ${tableName}...`);

      await axios.post(
        `${API_BASE_URL}/api/test/sessions/${this.sessionId}/tables/${tableName}/reset`,
        { approved_by: approvedBy },
      );

      console.log(`✅ ${tableName} resetada e pronta para retry!`);
    } catch (error) {
      this.handleError('resetTable', error);
    }
  }

  /**
   * Visualizar erros
   */
  async showErrors(): Promise<void> {
    if (!this.sessionId) {
      console.error('❌ Nenhuma sessão ativa.');
      process.exit(1);
    }

    try {
      const response = await axios.get(
        `${API_BASE_URL}/api/test/sessions/${this.sessionId}/errors`,
      );

      const data = response.data;

      if (data.errors.length === 0) {
        console.log('✅ Nenhum erro registrado!');
        return;
      }

      console.log(`\n❌ ERROS (${data.error_count}):`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      for (const error of data.errors) {
        console.log(`📌 Tabela: ${error.table}`);
        console.log(`   Mensagem: ${error.erro_mensagem}`);
        console.log(`   Timestamp: ${error.timestamp}`);

        if (error.erro_detalhes && error.erro_detalhes.stack) {
          console.log(`   Stack:`);
          console.log(`   ${error.erro_detalhes.stack.substring(0, 200)}...`);
        }

        console.log();
      }
    } catch (error) {
      this.handleError('showErrors', error);
    }
  }

  /**
   * Helpers
   */
  private extractErrorMessage(error: any): string {
    if (axios.isAxiosError(error)) {
      if (error.response?.data?.message) {
        return error.response.data.message;
      }
      if (error.response?.statusText) {
        return `${error.response.status} ${error.response.statusText}`;
      }
      return error.message;
    }
    return String(error);
  }

  private handleError(context: string, error: any): void {
    console.error(`\n❌ Erro em ${context}:`);
    if (axios.isAxiosError(error)) {
      console.error(`   Status: ${error.response?.status}`);
      console.error(`   Mensagem: ${error.message}`);
      if (error.response?.data) {
        console.error(`   Detalhes: ${JSON.stringify(error.response.data, null, 2)}`);
      }
    } else {
      console.error(`   ${error}`);
    }
  }

  /**
   * Restaurar sessão anterior
   */
  loadPreviousSession(): void {
    if (fs.existsSync(this.sessionFile)) {
      const data = fs.readFileSync(this.sessionFile, 'utf-8');
      const session = JSON.parse(data) as TestSession;
      this.sessionId = session.id;
      console.log(`📂 Sessão carregada: ${this.sessionId}`);
    }
  }
}

/**
 * MAIN
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  const cli = new TestSyncCLI();

  // Restaurar sessão anterior se disponível
  cli.loadPreviousSession();

  // Parse arguments
  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '--create') {
      const round = parseInt(args[i + 2] || '1', 10);
      const usuario = args[i + 1] || 'valdo@setes.com.br';
      await cli.createSession(usuario, round);
      i += 3;
    } else if (arg === '--round') {
      const round = parseInt(args[i + 1], 10);
      // Carregar contagem de registros para Round 1
      const registrosCounts = REGISTROS_COUNTS[round] || new Map();
      const success = await cli.runLevel(round - 1, registrosCounts);

      if (!success) {
        console.log(`\n⚠️  Teste parado. Revise os erros acima.`);
        console.log(`   Depois: npx ts-node scripts/test-sync-cli.ts --reset TABELA --approved-by valdo@setes.com.br`);
        console.log(`   E então: npx ts-node scripts/test-sync-cli.ts --round ${round}`);
        process.exit(1);
      }
      i += 2;
    } else if (arg === '--reset') {
      const tableName = args[i + 1];
      const approvedBy =
        args.includes('--approved-by') && args[args.indexOf('--approved-by') + 1];
      await cli.resetTable(tableName, approvedBy || 'valdo@setes.com.br');
      i += 2;
    } else if (arg === '--status') {
      await cli.getStatus();
      i++;
    } else if (arg === '--report') {
      await cli.generateReport();
      i++;
    } else if (arg === '--errors') {
      await cli.showErrors();
      i++;
    } else if (arg === '--map') {
      await cli.loadDependencyMap();
      i++;
    } else {
      console.error(`❓ Argumento desconhecido: ${arg}`);
      showHelp();
      process.exit(1);
    }
  }
}

function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║     Test Sync CLI — Sincronizador Incremental                  ║
╚════════════════════════════════════════════════════════════════╝

USAGE:
  npx ts-node scripts/test-sync-cli.ts [COMMAND] [OPTIONS]

COMMANDS:

  --create USER [ROUND]
    Criar nova sessão de testes
    Ex: --create valdo@setes.com.br 1

  --round N
    Executar testes de um level específico (0-6)
    Ex: --round 1  (executa Level 0, 7 catálogos)

  --status
    Ver status da sessão atual
    Ex: --status

  --report
    Gerar relatório final
    Ex: --report

  --errors
    Listar erros da sessão
    Ex: --errors

  --reset TABELA [--approved-by EMAIL]
    Resetar uma tabela para retry
    Ex: --reset TB_CLIENTE --approved-by valdo@setes.com.br

  --map
    Carregar mapa de dependências (32 tabelas)
    Ex: --map

EXEMPLOS:

  1. Criar nova sessão Round 1:
     $ npx ts-node scripts/test-sync-cli.ts --create valdo@setes.com.br 1

  2. Executar Level 0 (7 catálogos):
     $ npx ts-node scripts/test-sync-cli.ts --round 1

  3. Se falhar, ver erros:
     $ npx ts-node scripts/test-sync-cli.ts --errors

  4. Diagnosticar, corrigir código, depois resetar:
     $ npx ts-node scripts/test-sync-cli.ts --reset TB_CLIENTE --approved-by valdo@setes.com.br

  5. Retomar Round 1:
     $ npx ts-node scripts/test-sync-cli.ts --round 1

  6. Ver status:
     $ npx ts-node scripts/test-sync-cli.ts --status

  7. Gerar relatório final:
     $ npx ts-node scripts/test-sync-cli.ts --report

WORKFLOW COMPLETO:

  1. --create valdo@setes.com.br 1        (cria sessão)
  2. --round 1                             (executa Level 0)
  3. Se erro: --errors                     (diagnostica)
  4. Corrige código, depois:
  5. --reset TB_PROBLEMA --approved-by ... (aprova retry)
  6. --round 1                             (retoma)
  7. --report                              (relatório final)

`);
}

/**
 * Configuração de contagens de registros por Round
 * (estes valores devem corresponder aos seus dados reais)
 */
const REGISTROS_COUNTS: Record<number, Map<string, number>> = {
  1: new Map([
    ['TB_USUARIO', 32],
    ['TB_MARCA_PRODUTO', 5],
    ['TB_CATEGORY', 12],
    ['TB_MEDIDA', 8],
    ['TB_EMBALAGEM', 3],
    ['TB_PLANOCONTAS', 42],
    ['TB_FORMAPAGTO', 7],
  ]),
  2: new Map([
    ['TB_PRODUTO', 120],
    ['TB_ESTOQUES', 5],
    ['TB_PROMOTION', 2],
  ]),
  3: new Map([
    ['TB_TABELA_PRECO', 12],
    ['TB_PRECO', 200],
    ['TB_ESTOQUE', 150],
  ]),
  4: new Map([
    ['TB_TRANSPORTADORA', 5],
    ['TB_CONTABANCARIA', 3],
    ['TB_COLABORADOR', 8],
    ['TB_FORNECEDOR', 25],
    ['TB_CLIENTE', 42],
  ]),
};

main().catch(console.error);
