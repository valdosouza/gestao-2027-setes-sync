import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { childPath } from '@shared/tree-path'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Plano de Contas — ID LOCAL ✅ (MAPA_INDEXACAO): PLC_CODIGO do Firebird É
 * o id na web (tabela por institution, PK id+institution). Árvore ÚNICA
 * (diferente de category: sem separação por kind — o pai não precisa ter o
 * mesmo kind). O Delphi envia parentId (0 = raiz) e o posit_level é SEMPRE
 * recalculado aqui (@shared/tree-path — nunca confiar no nível legado).
 * Mover de pai move a subárvore inteira. Pai ainda não sincronizado → 409
 * (o Sincronizador loga e REENVIA no próximo ciclo). Domínios do DDL real:
 * source (coluna source_) = Natureza C(rédito)/D(ébito); kind = Tipo
 * C(usto)/R(esultado); cluster = Nível S(intética)/A(nalítica).
 * Contrato: CONTRATOS_SYNC.md.
 */
// Vazio/branco do legado = default do DDL (2026-08-01: plano raiz id=1 vinha
// com source/cluster '' e barrava a árvore inteira — pai de todo mundo).
const legacyEnum = <T extends [string, ...string[]]>(values: T, def: T[number]) =>
  z.preprocess(
    v => (typeof v === 'string' ? (v.trim() === '' ? undefined : v.trim()) : v),
    z.enum(values).optional().default(def)
  )

const financialPlanBody = z.object({
  id:          z.number().int().positive(),
  description: z.string().trim().min(1).max(100),
  parentId:    z.number().int().min(0).optional().default(0),
  source:      legacyEnum(['C', 'D'], 'C'),
  kind:        legacyEnum(['C', 'R'], 'C'),
  cluster:     legacyEnum(['S', 'A'], 'S'),
  active:      legacyEnum(['S', 'N'], 'S'),
  deleted:     legacyEnum(['S', 'N'], 'N'),
})

/**
 * @swagger
 * /financial-plans/sincronize:
 *   post:
 *     summary: Sincronizar Plano de Contas (árvore por institution, id local)
 *     description: >-
 *       Upsert em tb_financial_plans do schema do cliente com id = PLC_CODIGO
 *       do Firebird. posit_level recalculado no servidor a partir de parentId;
 *       mover de pai move a subárvore. Árvore única (sem separação por kind).
 *       Pai inexistente = 409 (reenvio no próximo ciclo). deleted='S' = soft
 *       delete. source = Natureza C/D, kind = Tipo C/R, cluster = Nível S/A.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, description, source, kind, cluster]
 *             properties:
 *               id: { type: integer, example: 12 }
 *               description: { type: string, example: "DESPESAS ADMINISTRATIVAS" }
 *               parentId: { type: integer, example: 0 }
 *               source: { type: string, enum: [C, D], example: "D" }
 *               kind: { type: string, enum: [C, R], example: "C" }
 *               cluster: { type: string, enum: [S, A], example: "A" }
 *               active: { type: string, enum: [S, N] }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Pai ainda não sincronizado — reenviar depois }
 *       500: { description: Erro ao processar }
 */
router.post('/financial-plans/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = financialPlanBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, description, parentId, source, kind, cluster, active, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    // Caminho do pai (0 = raiz). Árvore única: pai só precisa existir.
    let parentPath: string | null = null
    if (parentId > 0) {
      if (parentId === id) {
        throw new HttpError(400, 'parentId não pode ser o próprio id',
          [{ field: 'parentId', message: 'ciclo: conta não pode ser pai dela mesma' }])
      }
      const [parents] = await conn.query<any[]>(
        `SELECT posit_level FROM tb_financial_plans
         WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' LIMIT 1 FOR UPDATE`,
        [parentId, institutionId]
      )
      if (!parents.length) {
        throw new HttpError(409, `Conta pai ${parentId} ainda não sincronizada`,
          [{ field: 'parentId', message: 'sincronize o pai antes — reenvio no próximo ciclo' }],
          'PARENT_NOT_SYNCED')
      }
      parentPath = parents[0].posit_level
    }

    const newPath = childPath(parentPath, id)

    const [existing] = await conn.query<any[]>(
      `SELECT posit_level FROM tb_financial_plans
       WHERE id = ? AND tb_institution_id = ? LIMIT 1 FOR UPDATE`,
      [id, institutionId]
    )

    if (existing.length) {
      const oldPath: string = existing[0].posit_level
      if (oldPath && oldPath !== newPath) {
        // Mudou de pai: move a SUBÁRVORE (prefixo antigo → novo)
        await conn.query(
          `UPDATE tb_financial_plans
           SET posit_level = CONCAT(?, SUBSTRING(posit_level, ?)), updated_at = NOW()
           WHERE tb_institution_id = ? AND posit_level LIKE ?`,
          [newPath, oldPath.length + 1, institutionId, `${oldPath}.%`]
        )
      }
      await conn.query(
        `UPDATE tb_financial_plans
         SET description = ?, posit_level = ?, source_ = ?, kind = ?, cluster = ?,
             active = ?, deleted = ?, updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [description, newPath, source, kind, cluster, active, deleted, id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_financial_plans
           (id, tb_institution_id, description, posit_level, source_, kind, cluster,
            active, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, institutionId, description, newPath, source, kind, cluster, active, deleted]
      )
    }

    await conn.commit()
    res.json(syncSuccess(id))
  } catch (err: any) {
    await conn.rollback()
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ ok: false, error: err.message, fields: err.fields, code: err.code })
      return
    }
    logger.error('Erro em /financial-plans/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
