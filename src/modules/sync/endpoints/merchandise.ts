import { Router, Request, Response } from 'express'
import pool from '@shared/db/connection'
import { syncSuccess, syncError } from '../sync.response'
import { nextGlobalId, nextId } from '../sync.id-generator'
import { findOrCreateByDescription } from '../sync.lookup'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/merchandise/sincronize', async (req: Request, res: Response) => {
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(`USE \`${req.syncClient!.schemaName}\``)

    const { tb_institution_id, Produto, Mercadoria, Estoque, Marca, Embalagem } = req.body
    const institutionId: number = tb_institution_id

    // Resolver marca
    const brandId = await findOrCreateByDescription(conn, 'tb_brand', Marca.description)
    await conn.query(
      `INSERT IGNORE INTO tb_institution_has_brand (tb_institution_id, tb_brand_id) VALUES (?,?)`,
      [institutionId, brandId]
    )

    // Resolver embalagem
    const packageId = await findOrCreateByDescription(conn, 'tb_package', Embalagem.description)
    await conn.query(
      `INSERT IGNORE INTO tb_institution_has_package (tb_institution_id, tb_package_id) VALUES (?,?)`,
      [institutionId, packageId]
    )

    // tb_product (global)
    let productId: number = Produto.id
    if (!productId || productId === 0) {
      productId = await nextGlobalId(conn, 'tb_product')
    }
    const [exProd] = await conn.query<any[]>(
      `SELECT id FROM tb_product WHERE id=? LIMIT 1`, [productId]
    )
    if (exProd.length === 0) {
      await conn.query(
        `INSERT INTO tb_product (id, description, tb_category_id, active, created_at, updated_at)
         VALUES (?,?,?,?,NOW(),NOW())`,
        [productId, Produto.description, Produto.tb_category_id, Produto.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_product SET description=?, tb_category_id=?, active=?, updated_at=NOW()
         WHERE id=?`,
        [Produto.description, Produto.tb_category_id, Produto.active ?? 'S', productId]
      )
    }

    // tb_merchandise
    const [exMerc] = await conn.query<any[]>(
      `SELECT id FROM tb_merchandise WHERE id=? AND tb_institution_id=? LIMIT 1`,
      [productId, institutionId]
    )
    if (exMerc.length === 0) {
      await conn.query(
        `INSERT INTO tb_merchandise
           (id, tb_institution_id, tb_product_id, tb_brand_id, tb_package_id, codebar, price_cost, active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [productId, institutionId, productId, brandId, packageId,
         Mercadoria.codebar, Mercadoria.price_cost, Mercadoria.active ?? 'S']
      )
    } else {
      await conn.query(
        `UPDATE tb_merchandise SET tb_brand_id=?, tb_package_id=?, codebar=?, price_cost=?, active=?, updated_at=NOW()
         WHERE id=? AND tb_institution_id=?`,
        [brandId, packageId, Mercadoria.codebar, Mercadoria.price_cost, Mercadoria.active ?? 'S',
         productId, institutionId]
      )
    }

    // tb_stock
    if (Estoque?.tb_stock_list_id) {
      const [exStock] = await conn.query<any[]>(
        `SELECT id FROM tb_stock WHERE id=? AND tb_institution_id=? AND tb_stock_list_id=? LIMIT 1`,
        [productId, institutionId, Estoque.tb_stock_list_id]
      )
      if (exStock.length === 0) {
        await conn.query(
          `INSERT INTO tb_stock (id, tb_institution_id, tb_stock_list_id, tb_merchandise_id, codebar, created_at, updated_at)
           VALUES (?,?,?,?,?,NOW(),NOW())`,
          [productId, institutionId, Estoque.tb_stock_list_id, productId, Estoque.codebar]
        )
      } else {
        await conn.query(
          `UPDATE tb_stock SET codebar=?, updated_at=NOW()
           WHERE id=? AND tb_institution_id=? AND tb_stock_list_id=?`,
          [Estoque.codebar, productId, institutionId, Estoque.tb_stock_list_id]
        )
      }
    }

    await conn.commit()
    res.json(syncSuccess(institutionId))
  } catch (err: any) {
    await conn.rollback()
    logger.error('Erro em /merchandise/sincronize', { err, client: req.syncClient })
    res.json(syncError(err.message))
  } finally {
    conn.release()
  }
})

export default router
