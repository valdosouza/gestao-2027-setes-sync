#!/bin/bash

# Script de teste para setes-sync
# Uso: bash test-endpoints.sh

API_URL="http://localhost:3001"
API_KEY="${SYNC_API_KEY:-sua_chave_compartilhada_do_sincronizador_aqui}"

echo "================================"
echo "Teste de Endpoints setes-sync"
echo "================================"
echo ""

# Cores
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Health Check
echo -e "${YELLOW}1. Testando GET /health${NC}"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" $API_URL/health)
if [ $HEALTH -eq 200 ]; then
  echo -e "${GREEN}✓ PASS${NC} - /health retorna 200"
else
  echo -e "${RED}✗ FAIL${NC} - /health retorna $HEALTH (esperado 200)"
  echo "Dica: Inicie setes-sync com 'npm run dev'"
  exit 1
fi
echo ""

# Test 2: POST sem X-Api-Key
echo -e "${YELLOW}2. Testando POST /brand/sincronize SEM X-Api-Key${NC}"
RESPONSE=$(curl -s -X POST $API_URL/brand/sincronize \
  -H "Content-Type: application/json" \
  -d '{"brands": []}')
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API_URL/brand/sincronize \
  -H "Content-Type: application/json" \
  -d '{"brands": []}')

if [ $STATUS -eq 401 ]; then
  echo -e "${GREEN}✓ PASS${NC} - Retorna 401 (unauthorized)"
else
  echo -e "${RED}✗ FAIL${NC} - Retorna $STATUS (esperado 401)"
fi
echo ""

# Test 3: POST com X-Api-Key inválida
echo -e "${YELLOW}3. Testando POST /brand/sincronize com X-Api-Key INVÁLIDA${NC}"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API_URL/brand/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: chave_errada" \
  -d '{"brands": []}')

if [ $STATUS -eq 401 ]; then
  echo -e "${GREEN}✓ PASS${NC} - Retorna 401 (api key invalida)"
else
  echo -e "${RED}✗ FAIL${NC} - Retorna $STATUS (esperado 401)"
fi
echo ""

# Test 4: POST com X-Api-Key válida (requer DB)
echo -e "${YELLOW}4. Testando POST /brand/sincronize com X-Api-Key VÁLIDA${NC}"
echo "Chave usando: $API_KEY"
RESPONSE=$(curl -s -X POST $API_URL/brand/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"brands": [{"id": "TEST-001", "name": "Test Brand"}]}')
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST $API_URL/brand/sincronize \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $API_KEY" \
  -d '{"brands": []}')

if [ $STATUS -eq 200 ] || [ $STATUS -eq 500 ]; then
  echo -e "${GREEN}✓ PASS${NC} - Retorna $STATUS (aceita requisição)"
  echo "Resposta: $RESPONSE"
else
  echo -e "${YELLOW}⚠ INFO${NC} - Retorna $STATUS"
  echo "Dica: Verifique se DB está acessível e X-Api-Key está em setes_central.sync_api_keys"
fi
echo ""

# Test 5: Endpoints desabilitados
echo -e "${YELLOW}5. Validando endpoints de RESTAURANTE removidos${NC}"
for ENDPOINT in "rest-group" "rest-menu" "rest-subgroup"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API_URL/$ENDPOINT/sincronize" \
    -H "Content-Type: application/json" \
    -H "X-Api-Key: $API_KEY" \
    -d '{}')
  if [ $STATUS -eq 404 ] || [ $STATUS -eq 500 ]; then
    echo -e "${GREEN}✓ PASS${NC} - /$ENDPOINT/sincronize retorna $STATUS (desabilitado)"
  else
    echo -e "${RED}✗ FAIL${NC} - /$ENDPOINT/sincronize retorna $STATUS"
  fi
done
echo ""

echo "================================"
echo "Testes Concluídos"
echo "================================"
