import { Router, Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import { syncSuccess, syncError } from '../sync.response'
import logger from '@shared/logger/logger'

const router = Router()

router.post('/filexml/sincronize', async (req: Request, res: Response) => {
  try {
    const { FileName, FolderName, Content } = req.body

    const basePath   = process.env.XML_STORAGE_PATH ?? './storage/xml'
    const folderPath = path.join(basePath, FolderName)

    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true })
    }

    const filePath = path.join(folderPath, FileName)

    // Detecta se é Base64
    const isBase64 = /^[A-Za-z0-9+/]+=*$/.test(Content.trim().replace(/\s/g, ''))
    const buffer   = isBase64 ? Buffer.from(Content, 'base64') : Buffer.from(Content, 'utf-8')

    fs.writeFileSync(filePath, buffer)

    logger.info('XML salvo', { path: filePath })
    res.json(syncSuccess(0, 'SAVED'))
  } catch (err: any) {
    logger.error('Erro em /filexml/sincronize', { err })
    res.json(syncError(err.message))
  }
})

export default router
