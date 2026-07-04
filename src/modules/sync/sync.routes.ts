import { Router } from 'express'
import syncSpecificRoutes from './sync.specific.routes'

const router = Router()

// Registra todas as 30 rotas específicas de sincronização
// Ex: POST /brand/sincronize, POST /customer/sincronize, etc
router.use(syncSpecificRoutes)

export default router
