import { Router, Request, Response } from 'express'
import { z } from 'zod'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { childPath } from '@shared/tree-path'
import { HttpError } from '@shared/errors/http-error'
import logger from '@shared/logger/logger'

const router = Router()

/**
 * Categoria — ID LOCAL ✅ (MAPA_INDEXACAO): CAT_CODIGO do Firebird É o id
 * na web (tabela por institution, PK id+institution). Árvore: o Delphi
 * envia parentId (0 = raiz) e o posit_level é SEMPRE recalculado aqui
 * (@shared/tree-path — nunca confiar no CAT_NIVEL legado). Mover de pai
 * move a subárvore inteira (mesma matemática do módulo categories da API).
 * Pai ainda não sincronizado → 409 (o Sincronizador loga e REENVIA no
 * próximo ciclo — a ordem da fila TB_SINCRONIA não garante pai antes do
 * filho). Contrato: CONTRATOS_SYNC.md.
 */
const categoryBody = z.object({
  id:          z.number().int().positive(),
  description: z.string().trim().min(1).max(100),
  kind:        z.enum(['P', 'S']),
  parentId:    z.number().int().min(0).optional().default(0),
  active:      z.enum(['S', 'N']).optional().default('S'),
  deleted:     z.enum(['S', 'N']).optional().default('N'),
})

/**
 * @swagger
 * /category/sincronize:
 *   post:
 *     summary: Sincronizar Categoria (árvore por institution, id local)
 *     description: >-
 *       Upsert em tb_category do schema do cliente com id = CAT_CODIGO do
 *       Firebird. posit_level recalculado no servidor a partir de parentId;
 *       mover de pai move a subárvore. Pai inexistente = 409 (reenvio no
 *       próximo ciclo). deleted='S' = soft delete.
 *     tags: [Sincronização]
 *     security: [{ ApiKeyAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id, description, kind]
 *             properties:
 *               id: { type: integer, example: 12 }
 *               description: { type: string, example: "BEBIDAS" }
 *               kind: { type: string, enum: [P, S], example: "P" }
 *               parentId: { type: integer, example: 0 }
 *               active: { type: string, enum: [S, N] }
 *               deleted: { type: string, enum: [S, N] }
 *     responses:
 *       200: { description: "{ ok, id }" }
 *       400: { description: Payload inválido }
 *       401: { description: X-Api-Key inválida ou ausente }
 *       409: { description: Pai ainda não sincronizado — reenviar depois }
 *       500: { description: Erro ao processar }
 */
router.post('/category/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    const parsed = categoryBody.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'Payload inválido',
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })))
    }
    const { id, description, kind, parentId, active, deleted } = parsed.data
    const { institutionId, schemaName } = req.syncClient!

    await conn.beginTransaction()
    await conn.query(`USE \`${schemaName}\``)

    // Caminho do pai (0 = raiz). Pai precisa existir e ser do mesmo kind.
    let parentPath: string | null = null
    if (parentId > 0) {
      if (parentId === id) {
        throw new HttpError(400, 'parentId não pode ser o próprio id',
          [{ field: 'parentId', message: 'ciclo: categoria não pode ser pai dela mesma' }])
      }
      const [parents] = await conn.query<any[]>(
        `SELECT posit_level, kind FROM tb_category
         WHERE id = ? AND tb_institution_id = ? AND deleted = 'N' LIMIT 1 FOR UPDATE`,
        [parentId, institutionId]
      )
      if (!parents.length) {
        throw new HttpError(409, `Categoria pai ${parentId} ainda não sincronizada`,
          [{ field: 'parentId', message: 'sincronize o pai antes — reenvio no próximo ciclo' }],
          'PARENT_NOT_SYNCED')
      }
      if (parents[0].kind !== kind) {
        throw new HttpError(400, 'kind diferente do pai',
          [{ field: 'kind', message: `pai é '${parents[0].kind}' — árvores P/S são independentes` }])
      }
      parentPath = parents[0].posit_level
    }

    const newPath = childPath(parentPath, id)

    const [existing] = await conn.query<any[]>(
      `SELECT posit_level FROM tb_category
       WHERE id = ? AND tb_institution_id = ? LIMIT 1 FOR UPDATE`,
      [id, institutionId]
    )

    if (existing.length) {
      const oldPath: string = existing[0].posit_level
      if (oldPath && oldPath !== newPath) {
        // Mudou de pai: move a SUBÁRVORE (prefixo antigo → novo)
        await conn.query(
          `UPDATE tb_category
           SET posit_level = CONCAT(?, SUBSTRING(posit_level, ?)), updated_at = NOW()
           WHERE tb_institution_id = ? AND posit_level LIKE ?`,
          [newPath, oldPath.length + 1, institutionId, `${oldPath}.%`]
        )
      }
      await conn.query(
        `UPDATE tb_category
         SET description = ?, kind = ?, posit_level = ?, active = ?, deleted = ?, updated_at = NOW()
         WHERE id = ? AND tb_institution_id = ?`,
        [description, kind, newPath, active, deleted, id, institutionId]
      )
    } else {
      await conn.query(
        `INSERT INTO tb_category
           (id, tb_institution_id, description, posit_level, kind, active, deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, institutionId, description, newPath, kind, active, deleted]
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
    logger.error('Erro em /category/sincronize', { err, client: req.syncClient })
    res.status(500).json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
