import { Router } from 'express'
import { syncAuthMiddleware } from './sync.auth.middleware'

import bankaccountRouter           from './endpoints/bankaccount'
import brandRouter                 from './endpoints/brand'
import cashierRouter               from './endpoints/cashier'
import categoryRouter              from './endpoints/category'
import customerRouter              from './endpoints/customer'
import filexmlRouter               from './endpoints/filexml'
import financialRouter             from './endpoints/financial'
import financialplansRouter        from './endpoints/financialplans'
import financialstatementRouter    from './endpoints/financialstatement'
import merchandiseRouter           from './endpoints/merchandise'
import orderpurchaseRouter         from './endpoints/orderpurchase'
import ordersaleRouter             from './endpoints/ordersale'
import orderstockadjustRouter      from './endpoints/orderstockadjust'
import packageRouter               from './endpoints/package'
import paymenttypeRouter           from './endpoints/paymenttype'
import priceRouter                 from './endpoints/price'
import pricelistRouter             from './endpoints/pricelist'
import promotionRouter             from './endpoints/promotion'
import providerRouter  from './endpoints/provider'
import salesmanRouter from './endpoints/salesman'
import stockbalanceRouter          from './endpoints/stockbalance'
import stocklistRouter             from './endpoints/stocklist'
import stockstatementRouter        from './endpoints/stockstatement'

const router = Router()

// Auth apenas para rotas /sincronize — deixa outras passarem sem bloquear
router.use((req, res, next) => {
  if (!req.path.toLowerCase().includes('sincronize')) return next('router')
  syncAuthMiddleware(req, res, next)
})

router.use(bankaccountRouter)
router.use(brandRouter)
router.use(cashierRouter)
router.use(categoryRouter)
router.use(customerRouter)
router.use(filexmlRouter)
router.use(financialRouter)
router.use(financialplansRouter)
router.use(financialstatementRouter)
router.use(merchandiseRouter)
router.use(orderpurchaseRouter)
router.use(ordersaleRouter)
router.use(orderstockadjustRouter)
router.use(packageRouter)
router.use(paymenttypeRouter)
router.use(priceRouter)
router.use(pricelistRouter)
router.use(promotionRouter)
router.use(providerRouter)
router.use(salesmanRouter)
router.use(stockbalanceRouter)
router.use(stocklistRouter)
router.use(stockstatementRouter)

export default router
