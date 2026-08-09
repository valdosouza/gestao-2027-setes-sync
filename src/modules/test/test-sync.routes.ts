import { Router, Request, Response } from 'express'
import { TestSyncService } from './test-sync.service'

const router = Router()
const testSyncService = new TestSyncService()

/**
 * GET /api/test/dependency-map
 * Retorna o mapa de 32 tabelas ordenadas por nível de dependência
 */
router.get('/dependency-map', async (req: Request, res: Response) => {
  try {
    const map = await testSyncService.getDependencyMap()
    res.json(map)
  } catch (error) {
    console.error('Error in GET /dependency-map:', error)
    res.status(500).json({ error: 'Failed to load dependency map' })
  }
})

/**
 * POST /api/test/sessions
 * Criar nova sessão de testes
 */
router.post('/sessions', async (req: Request, res: Response) => {
  try {
    const { usuario, observacoes } = req.body
    const result = await testSyncService.createSession(usuario, observacoes)
    res.status(201).json(result)
  } catch (error) {
    console.error('Error in POST /sessions:', error)
    res.status(500).json({ error: 'Failed to create session' })
  }
})

/**
 * GET /api/test/sessions/:sessionId
 * Ver status da sessão
 */
router.get('/sessions/:sessionId', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params
    const session = await testSyncService.getSession(sessionId)
    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }
    const { logs } = await testSyncService.getSessionLogs(sessionId)
    const summary = testSyncService.summarizeLogs(logs as any[])
    res.json({ session, summary, logs })
  } catch (error) {
    console.error('Error in GET /sessions/:sessionId:', error)
    res.status(500).json({ error: 'Failed to get session' })
  }
})

/**
 * POST /api/test/sessions/:sessionId/tables/:tableName/start
 * Registrar início de teste da tabela
 */
router.post('/sessions/:sessionId/tables/:tableName/start', async (req: Request, res: Response) => {
  try {
    const { sessionId, tableName } = req.params
    const { registros_esperados } = req.body
    const result = await testSyncService.startTableLog(sessionId, tableName, registros_esperados)
    res.json(result)
  } catch (error) {
    console.error('Error in POST /sessions/:sessionId/tables/:tableName/start:', error)
    res.status(500).json({ error: 'Failed to start table test' })
  }
})

/**
 * POST /api/test/sessions/:sessionId/tables/:tableName/finish
 * Registrar fim de teste (sucesso ou falha)
 */
router.post('/sessions/:sessionId/tables/:tableName/finish', async (req: Request, res: Response) => {
  try {
    const { sessionId, tableName } = req.params
    const { status, registros_enviados, erro_mensagem, erro_detalhes } = req.body
    const result = await testSyncService.finishTableLog(sessionId, tableName, {
      status,
      registros_enviados,
      erro_mensagem,
      erro_detalhes,
    })
    res.json(result)
  } catch (error) {
    console.error('Error in POST /sessions/:sessionId/tables/:tableName/finish:', error)
    res.status(500).json({ error: 'Failed to finish table test' })
  }
})

/**
 * POST /api/test/sessions/:sessionId/tables/:tableName/reset
 * Limpar dados de teste e marcar para retry
 */
router.post('/sessions/:sessionId/tables/:tableName/reset', async (req: Request, res: Response) => {
  try {
    const { sessionId, tableName } = req.params
    const { approved_by } = req.body

    if (!approved_by) {
      return res.status(400).json({ error: 'approved_by is required' })
    }

    const result = await testSyncService.resetTableLog(sessionId, tableName, approved_by)
    res.json(result)
  } catch (error) {
    console.error('Error in POST /sessions/:sessionId/tables/:tableName/reset:', error)
    res.status(500).json({ error: 'Failed to reset table test' })
  }
})

/**
 * GET /api/test/sessions/:sessionId/errors
 * Listar erros da sessão
 */
router.get('/sessions/:sessionId/errors', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params
    const result = await testSyncService.getSessionErrors(sessionId)
    res.json(result)
  } catch (error) {
    console.error('Error in GET /sessions/:sessionId/errors:', error)
    res.status(500).json({ error: 'Failed to get errors' })
  }
})

/**
 * GET /api/test/sessions/:sessionId/report
 * Gerar relatório final da sessão
 */
router.get('/sessions/:sessionId/report', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params
    const result = await testSyncService.getSessionReport(sessionId)
    res.json(result)
  } catch (error) {
    console.error('Error in GET /sessions/:sessionId/report:', error)
    res.status(500).json({ error: 'Failed to generate report' })
  }
})

/**
 * GET /api/test/sessions/:sessionId/logs
 * Exportar logs completos em JSON (para Excel)
 */
router.get('/sessions/:sessionId/logs', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params
    const result = await testSyncService.getSessionLogs(sessionId)
    res.json(result)
  } catch (error) {
    console.error('Error in GET /sessions/:sessionId/logs:', error)
    res.status(500).json({ error: 'Failed to get logs' })
  }
})

/**
 * POST /api/test/sessions/:sessionId/finalize
 * Finalizar sessão de testes
 */
router.post('/sessions/:sessionId/finalize', async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params
    const result = await testSyncService.finalizeSession(sessionId)
    res.json(result)
  } catch (error) {
    console.error('Error in POST /sessions/:sessionId/finalize:', error)
    res.status(500).json({ error: 'Failed to finalize session' })
  }
})

export default router
