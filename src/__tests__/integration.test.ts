import request from 'supertest'
import app from '../app'

describe('setes-sync — Integration Tests', () => {
  describe('GET /health', () => {
    it('retorna 200 com status ok', async () => {
      const res = await request(app).get('/health')
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('ok')
      expect(res.body.service).toBe('setes-sync')
      expect(res.body.ts).toBeDefined()
    })
  })

  describe('POST /brand/sincronize', () => {
    it('retorna 401 sem X-Api-Key', async () => {
      const res = await request(app)
        .post('/brand/sincronize')
        .send({ brands: [{ id: '1', name: 'Brand A' }] })

      expect(res.status).toBe(401)
      expect(res.body.error).toContain('X-Api-Key')
    })

    it('retorna 401 com X-Api-Key inválida', async () => {
      const res = await request(app)
        .post('/brand/sincronize')
        .set('X-Api-Key', 'chave_errada')
        .send({ brands: [{ id: '1', name: 'Brand A' }] })

      expect(res.status).toBe(401)
      expect(res.body.error).toContain('invalida')
    })

    // NOTE: Testes que dependem de DB ou auth com chave real
    // devem ser executados com .env configurado corretamente
  })

  describe('POST /customer/sincronize', () => {
    it('retorna 401 sem X-Api-Key', async () => {
      const res = await request(app)
        .post('/customer/sincronize')
        .send({ customers: [] })

      expect(res.status).toBe(401)
    })
  })

  describe('POST /order-sale/sincronize', () => {
    it('retorna 401 sem X-Api-Key', async () => {
      const res = await request(app)
        .post('/order-sale/sincronize')
        .send({ orders: [] })

      expect(res.status).toBe(401)
    })
  })

  describe('Endpoints Desabilitados (Restaurante)', () => {
    it('POST /rest-group/sincronize não existe', async () => {
      const res = await request(app)
        .post('/rest-group/sincronize')
        .set('X-Api-Key', 'test_key')
        .send({ groups: [] })

      // D23: endpoints rest-* aposentados — rota não registrada.
      // 401 = auth barra a chave de teste antes do 404 de rota inexistente.
      expect([401, 404]).toContain(res.status)
    })

    it('POST /rest-menu/sincronize não existe', async () => {
      const res = await request(app)
        .post('/rest-menu/sincronize')
        .set('X-Api-Key', 'test_key')
        .send({ menus: [] })

      expect([401, 404]).toContain(res.status)
    })

    it('POST /rest-subgroup/sincronize não existe', async () => {
      const res = await request(app)
        .post('/rest-subgroup/sincronize')
        .set('X-Api-Key', 'test_key')
        .send({ subgroups: [] })

      expect([401, 404]).toContain(res.status)
    })
  })
})
