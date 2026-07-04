import { Router } from 'express'
import syncRoutes from '@modules/sync/sync.routes'

const router = Router()

router.use(syncRoutes)

export default router
