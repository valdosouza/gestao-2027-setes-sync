import { randomUUID } from 'crypto'
import { getConnection } from '@shared/db/connection'

/**
 * Mapa de dependências entre tabelas.
 * Level 0 = nenhuma dependência em tabelas sincronizadas.
 * Level N = só depende de tabelas do Level < N.
 */
export interface TableDependency {
  level: number
  table_name: string
  send_class?: string
  endpoint: string
  dependencies: string[]
}

export class TestSyncService {
  private dependencyMap: TableDependency[] = []
  private tablesReady: Promise<void> | null = null

  constructor() {
    this.initializeDependencyMap()
  }

  /**
   * Cria as tabelas de log em setes_central se ainda não existirem
   * (bootstrap automático — sem migration manual).
   */
  private ensureTables(): Promise<void> {
    if (!this.tablesReady) {
      this.tablesReady = (async () => {
        const conn = await getConnection('setes_central')
        try {
          await conn.query(`
            CREATE TABLE IF NOT EXISTS tb_sync_test_session (
              id VARCHAR(36) NOT NULL PRIMARY KEY,
              iniciadp_em DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
              finalizado_em DATETIME NULL,
              status ENUM('em_andamento','parado','concluido') NOT NULL DEFAULT 'em_andamento',
              observacoes TEXT NULL,
              usuario VARCHAR(100) NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          `)
          await conn.query(`
            CREATE TABLE IF NOT EXISTS tb_sync_test_log (
              id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              test_session_id VARCHAR(36) NOT NULL,
              table_name VARCHAR(100) NOT NULL,
              send_class VARCHAR(100) NULL,
              endpoint VARCHAR(100) NULL,
              status ENUM('pending','running','success','failed','reset') NOT NULL DEFAULT 'pending',
              registros_esperados INT NULL,
              registros_enviados INT NULL,
              registros_falhados INT NULL,
              erro_mensagem TEXT NULL,
              erro_detalhes JSON NULL,
              timestamp_inicio DATETIME NULL,
              timestamp_fim DATETIME NULL,
              aprovado_por VARCHAR(100) NULL,
              aprovado_em DATETIME NULL,
              pronto_retry TINYINT(1) NOT NULL DEFAULT 0,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              KEY idx_session (test_session_id),
              KEY idx_status (status),
              CONSTRAINT fk_test_log_session FOREIGN KEY (test_session_id)
                REFERENCES tb_sync_test_session (id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          `)
        } finally {
          conn.release()
        }
      })()
      // se falhar, permite nova tentativa na próxima chamada
      this.tablesReady.catch(() => {
        this.tablesReady = null
      })
    }
    return this.tablesReady
  }

  /**
   * Inicializa o mapa de dependências com as 32 tabelas sincronizadas.
   */
  private initializeDependencyMap(): void {
    this.dependencyMap = [
      // ========== LEVEL 0: Catalog/Reference (No FK Dependencies) ==========
      {
        level: 0,
        table_name: 'TB_USUARIO',
        send_class: 'TUserSendWeb',
        endpoint: '/user/sincronize',
        dependencies: [],
      },
      {
        level: 0,
        table_name: 'TB_MARCA_PRODUTO',
        send_class: 'TBrandSendWeb',
        endpoint: '/brand/sincronize',
        dependencies: [],
      },
      {
        level: 0,
        table_name: 'TB_CATEGORY',
        send_class: 'TCategorySendWeb',
        endpoint: '/category/sincronize',
        dependencies: [],
      },
      {
        level: 0,
        table_name: 'TB_MEDIDA',
        send_class: 'TMeasureSendWeb',
        endpoint: '/measure/sincronize',
        dependencies: [],
      },
      {
        level: 0,
        table_name: 'TB_EMBALAGEM',
        send_class: 'TPackageSendWeb',
        endpoint: '/package/sincronize',
        dependencies: [],
      },
      {
        level: 0,
        table_name: 'TB_PLANOCONTAS',
        send_class: 'TFinancialPlansSendWeb',
        endpoint: '/financial-plans/sincronize',
        dependencies: [],
      },
      {
        level: 0,
        table_name: 'TB_FORMAPAGTO',
        send_class: 'TPaymentTypeSendWeb',
        endpoint: '/payment-type/sincronize',
        dependencies: [],
      },

      // ========== LEVEL 1: Depende de Level 0 ==========
      {
        level: 1,
        table_name: 'TB_PRODUTO',
        send_class: 'TMerchandiseSendWeb',
        endpoint: '/merchandise/sincronize',
        dependencies: ['TB_MARCA_PRODUTO', 'TB_MEDIDA', 'TB_EMBALAGEM', 'TB_CATEGORY'],
      },
      {
        level: 1,
        table_name: 'TB_PRODUTO',
        send_class: 'TServiceSendWeb',
        endpoint: '/service/sincronize',
        dependencies: ['TB_CATEGORIA'],
      },
      {
        level: 1,
        table_name: 'TB_ESTOQUES',
        send_class: 'TStockListSendWeb',
        endpoint: '/stock-list/sincronize',
        dependencies: [],
      },
      {
        level: 1,
        table_name: 'TB_PROMOTION',
        send_class: 'TPromotionSendWeb',
        endpoint: '/promotion/sincronize',
        dependencies: ['TB_PRODUTO'],
      },

      // ========== LEVEL 2: Depende de Levels 0-1 ==========
      {
        level: 2,
        table_name: 'TB_TABELA_PRECO',
        send_class: 'TPriceListSendWeb',
        endpoint: '/price-list/sincronize',
        dependencies: [],
      },
      {
        level: 2,
        table_name: 'TB_PRECO',
        send_class: 'TPriceSendWeb',
        endpoint: '/price/sincronize',
        dependencies: ['TB_TABELA_PRECO', 'TB_PRODUTO'],
      },
      {
        level: 2,
        table_name: 'TB_ESTOQUE',
        send_class: 'TStockBalanceSendWeb',
        endpoint: '/stock-balance/sincronize',
        dependencies: ['TB_ESTOQUES', 'TB_PRODUTO'],
      },

      // ========== LEVEL 3: Entity Master Records ==========
      {
        level: 3,
        table_name: 'TB_TRANSPORTADORA',
        send_class: 'TCarrierSendWeb',
        endpoint: '/carrier/sincronize',
        dependencies: [],
      },
      {
        level: 3,
        table_name: 'TB_CONTABANCARIA',
        send_class: 'TBankAccountSendWeb',
        endpoint: '/bank-account/sincronize',
        dependencies: [],
      },
      {
        level: 3,
        table_name: 'TB_COLABORADOR',
        send_class: 'TSalesManSendWeb',
        endpoint: '/salesman/sincronize',
        dependencies: [],
      },
      {
        level: 3,
        table_name: 'TB_FORNECEDOR',
        send_class: 'TProviderSendWeb',
        endpoint: '/provider/sincronize',
        dependencies: [],
      },
      {
        level: 3,
        table_name: 'TB_CLIENTE',
        send_class: 'TCustomerSendWeb',
        endpoint: '/customer/sincronize',
        dependencies: ['TB_TRANSPORTADORA'],
      },

      // ========== LEVEL 4: Inventory Operations ==========
      {
        level: 4,
        table_name: 'TB_CTRL_ESTOQUE',
        send_class: 'TStockStatementSendWeb',
        endpoint: '/stock-statement/sincronize',
        dependencies: ['TB_ESTOQUE', 'TB_PRODUTO'],
      },

      // ========== LEVEL 5: Financial/Accounting ==========
      {
        level: 5,
        table_name: 'TB_FINANCEIRO',
        send_class: 'TFinancialSendWeb',
        endpoint: '/financial/sincronize',
        dependencies: [],
      },
      {
        level: 5,
        table_name: 'TB_MOVIM_FINANCEIRO',
        send_class: 'TFinancialStatementSendWeb',
        endpoint: '/financial-statement/sincronize',
        dependencies: ['TB_FINANCEIRO'],
      },
      {
        level: 5,
        table_name: 'TB_CASHIER',
        send_class: 'TCashierSendWeb',
        endpoint: '/cashier/sincronize',
        dependencies: ['TB_USUARIO'],
      },

      // ========== LEVEL 6: Business Documents (Invoices/Orders) ==========
      {
        level: 6,
        table_name: 'TB_NOTA_FISCAL',
        send_class: 'TInvoiceSendWeb',
        endpoint: '/invoice/sincronize',
        dependencies: ['TB_CLIENTE'],
      },
      {
        level: 6,
        table_name: 'TB_NOTA_FISCAL',
        send_class: 'TInvoiceServiceSendWeb',
        endpoint: '/order-service/sincronize',
        dependencies: ['TB_CLIENTE'],
      },
      {
        level: 6,
        table_name: 'TB_NOTA_FISCAL',
        send_class: 'TInvoiceMerchandiseSaleSendWeb',
        endpoint: '/order-sale/sincronize',
        dependencies: ['TB_CLIENTE'],
      },
      {
        level: 6,
        table_name: 'TB_NOTA_FISCAL',
        send_class: 'TInvoiceMerchandisePurchaseSendWeb',
        endpoint: '/order-purchase/sincronize',
        dependencies: ['TB_FORNECEDOR'],
      },
      {
        level: 6,
        table_name: 'TB_NOTA_FISCAL',
        send_class: 'TInvoiceMerchandiseAdjustSendWeb',
        endpoint: '/order-stock-adjust/sincronize',
        dependencies: [],
      },

      // ========== LEVEL 7: Invoice Returns & Attachments ==========
      {
        level: 7,
        table_name: 'TB_RETORNO_NFE',
        send_class: 'TInvoiceReturn55SendWeb',
        endpoint: '/invoice-return-55/sincronize',
        dependencies: ['TB_NOTA_FISCAL'],
      },
      {
        level: 7,
        table_name: 'TB_RETORNO_NFC',
        send_class: 'TInvoiceReturn65SendWeb',
        endpoint: '/invoice-return-65/sincronize',
        dependencies: ['TB_NOTA_FISCAL'],
      },
      {
        level: 7,
        table_name: 'TB_RETORNO_NFS',
        send_class: 'TInvoiceReturnServiceSendWeb',
        endpoint: '/invoice-return-service/sincronize',
        dependencies: ['TB_NOTA_FISCAL'],
      },
      {
        level: 7,
        table_name: 'TB_ARQUIVOS',
        send_class: 'TFileSendWeb',
        endpoint: '/filexml/sincronize',
        dependencies: ['TB_NOTA_FISCAL'],
      },
    ]
  }

  /**
   * Retorna o mapa de dependências
   */
  async getDependencyMap(): Promise<TableDependency[]> {
    return this.dependencyMap.sort((a, b) => a.level - b.level)
  }

  /**
   * Resumir logs (contagem por status e por level)
   */
  summarizeLogs(logs: any[]) {
    const summary = {
      total: logs.length,
      succeeded: logs.filter((l) => l.status === 'success').length,
      failed: logs.filter((l) => l.status === 'failed').length,
      pending: logs.filter((l) => l.status === 'pending' || l.status === 'running').length,
      by_level: {} as Record<number, { total: number; succeeded: number; failed: number }>,
    }

    for (const log of logs) {
      const tableInfo = this.dependencyMap.find((t) => t.table_name === log.table_name)
      const level = tableInfo?.level ?? -1
      if (!summary.by_level[level]) {
        summary.by_level[level] = { total: 0, succeeded: 0, failed: 0 }
      }
      summary.by_level[level].total++
      if (log.status === 'success') summary.by_level[level].succeeded++
      else if (log.status === 'failed') summary.by_level[level].failed++
    }

    return summary
  }

  /**
   * Criar nova sessão de testes
   */
  async createSession(usuario: string, observacoes: string) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')
    const sessionId = randomUUID()

    try {
      await conn.execute(
        `INSERT INTO tb_sync_test_session (id, usuario, observacoes, status, iniciadp_em) VALUES (?, ?, ?, 'em_andamento', NOW())`,
        [sessionId, usuario, observacoes || '']
      )

      return {
        session_id: sessionId,
        created_at: new Date().toISOString(),
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Obter sessão
   */
  async getSession(sessionId: string) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')

    try {
      const [rows] = await conn.execute(
        `SELECT * FROM tb_sync_test_session WHERE id = ?`,
        [sessionId]
      )

      if (Array.isArray(rows) && rows.length > 0) {
        return rows[0]
      }
      return null
    } finally {
      conn.release()
    }
  }

  /**
   * Obter logs de uma sessão
   */
  async getSessionLogs(sessionId: string) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')

    try {
      const [logs] = await conn.execute(
        `SELECT * FROM tb_sync_test_log WHERE test_session_id = ? ORDER BY id ASC`,
        [sessionId]
      )

      return {
        session_id: sessionId,
        logs: Array.isArray(logs) ? logs : [],
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Iniciar log de teste de tabela
   */
  async startTableLog(sessionId: string, tableName: string, registros_esperados: number) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')
    const tableInfo = this.dependencyMap.find((t) => t.table_name === tableName)

    try {
      const [result] = await conn.execute(
        `INSERT INTO tb_sync_test_log
         (test_session_id, table_name, send_class, endpoint, status, registros_esperados, timestamp_inicio)
         VALUES (?, ?, ?, ?, 'running', ?, NOW())`,
        [sessionId, tableName, tableInfo?.send_class ?? null, tableInfo?.endpoint ?? null, registros_esperados]
      )

      return {
        log_id: (result as any).insertId,
        started_at: new Date().toISOString(),
        status: 'running',
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Finalizar log de teste (sucesso ou erro)
   */
  async finishTableLog(
    sessionId: string,
    tableName: string,
    body: { status: string; registros_enviados?: number; erro_mensagem?: string; erro_detalhes?: any }
  ) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')

    try {
      const [rows] = await conn.execute(
        `SELECT * FROM tb_sync_test_log WHERE test_session_id = ? AND table_name = ? ORDER BY id DESC LIMIT 1`,
        [sessionId, tableName]
      )

      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('Log not found')
      }

      const logId = (rows[0] as any).id

      await conn.execute(
        `UPDATE tb_sync_test_log SET status = ?, registros_enviados = ?, erro_mensagem = ?, erro_detalhes = ?, timestamp_fim = NOW() WHERE id = ?`,
        [body.status, body.registros_enviados || 0, body.erro_mensagem || null, JSON.stringify(body.erro_detalhes || {}), logId]
      )

      return {
        log_id: logId,
        status: body.status,
        finished_at: new Date().toISOString(),
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Resetar teste (limpar tabela de destino + marcar para retry)
   */
  async resetTableLog(sessionId: string, tableName: string, approvedBy: string) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')

    try {
      const [rows] = await conn.execute(
        `SELECT * FROM tb_sync_test_log WHERE test_session_id = ? AND table_name = ? ORDER BY id DESC LIMIT 1`,
        [sessionId, tableName]
      )

      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error('Log not found')
      }

      const logId = (rows[0] as any).id

      await conn.execute(
        `UPDATE tb_sync_test_log SET status = 'reset', pronto_retry = true, aprovado_por = ?, aprovado_em = NOW() WHERE id = ?`,
        [approvedBy, logId]
      )

      return {
        log_id: logId,
        status: 'reset',
        ready_for_retry: true,
        reset_by: approvedBy,
        reset_at: new Date().toISOString(),
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Obter erros de uma sessão
   */
  async getSessionErrors(sessionId: string) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')

    try {
      const [errors] = await conn.execute(
        `SELECT * FROM tb_sync_test_log WHERE test_session_id = ? AND status = 'failed' ORDER BY id ASC`,
        [sessionId]
      )

      return {
        session_id: sessionId,
        error_count: Array.isArray(errors) ? errors.length : 0,
        errors: (Array.isArray(errors) ? errors : []).map((e: any) => ({
          table: e.table_name,
          status: e.status,
          erro_mensagem: e.erro_mensagem,
          erro_detalhes: e.erro_detalhes ? JSON.parse(e.erro_detalhes) : {},
          timestamp: e.timestamp_fim,
        })),
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Gerar relatório final
   */
  async getSessionReport(sessionId: string) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')

    try {
      const [sessionRows] = await conn.execute(
        `SELECT * FROM tb_sync_test_session WHERE id = ?`,
        [sessionId]
      )

      const [logRows] = await conn.execute(
        `SELECT * FROM tb_sync_test_log WHERE test_session_id = ? ORDER BY id ASC`,
        [sessionId]
      )

      const session = Array.isArray(sessionRows) ? (sessionRows[0] as any) : null
      const logs: any[] = Array.isArray(logRows) ? (logRows as any[]) : []

      if (!session) {
        throw new Error('Session not found')
      }

      const resumo = {
        total_tabelas: logs.length,
        sucesso: logs.filter((l: any) => l.status === 'success').length,
        falha: logs.filter((l: any) => l.status === 'failed').length,
        aguardando: logs.filter((l: any) => l.status === 'pending').length,
      }

      const duracao = session.finalizado_em
        ? (new Date(session.finalizado_em).getTime() - new Date(session.iniciadp_em).getTime()) / 60000
        : 0

      return {
        session_id: session.id,
        usuario: session.usuario,
        status: session.status,
        iniciado_em: session.iniciadp_em,
        finalizado_em: session.finalizado_em,
        duracao_minutos: duracao,
        resumo,
        detalhes: logs.map((log: any) => {
          const tableInfo = this.dependencyMap.find((t) => t.table_name === log.table_name)
          const duration =
            log.timestamp_fim && log.timestamp_inicio
              ? (new Date(log.timestamp_fim).getTime() - new Date(log.timestamp_inicio).getTime()) / 1000
              : 0

          return {
            table: log.table_name,
            level: tableInfo?.level ?? -1,
            status: log.status,
            registros: {
              esperados: log.registros_esperados,
              enviados: log.registros_enviados || 0,
              falhados: log.registros_falhados || 0,
            },
            tempo_segundos: duration,
          }
        }),
      }
    } finally {
      conn.release()
    }
  }

  /**
   * Finalizar sessão de testes
   */
  async finalizeSession(sessionId: string) {
    await this.ensureTables()
    const conn = await getConnection('setes_central')

    try {
      await conn.execute(`UPDATE tb_sync_test_session SET status = 'concluido', finalizado_em = NOW() WHERE id = ?`, [sessionId])

      const [rows] = await conn.execute(`SELECT * FROM tb_sync_test_session WHERE id = ?`, [sessionId])

      return Array.isArray(rows) ? rows[0] : null
    } finally {
      conn.release()
    }
  }
}
