-- ============================================
-- SETUP MULTI-TENANT PARA SETES-SYNC
-- Execute este script no MySQL para configurar
-- o banco de dados multi-tenant
-- ============================================

-- 1. Usar banco central
USE setes_central;

-- 2. Criar tabela de tenants
CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  schema_name VARCHAR(100) NOT NULL UNIQUE,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_schema (schema_name),
  INDEX idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Criar tabela de API keys
CREATE TABLE IF NOT EXISTS sync_api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  api_key VARCHAR(255) NOT NULL UNIQUE,
  tenant_id VARCHAR(36) NOT NULL,
  establishment_code VARCHAR(20) NOT NULL,
  description VARCHAR(255),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  INDEX idx_api_key (api_key),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Criar tabela de logs
CREATE TABLE IF NOT EXISTS sync_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(36) NOT NULL,
  endpoint VARCHAR(100) NOT NULL,
  direction VARCHAR(10),
  table_name VARCHAR(100),
  records_count INT DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending',
  error_message TEXT,
  duration_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  INDEX idx_tenant (tenant_id),
  INDEX idx_endpoint (endpoint),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Inserir clientes de teste
INSERT INTO tenants (id, name, schema_name, active) VALUES
('cliente-a', 'Empresa Alpha', 'schema_cliente_a', TRUE),
('cliente-b', 'Empresa Beta', 'schema_cliente_b', TRUE),
('cliente-c', 'Empresa Gamma', 'schema_cliente_c', TRUE)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- 6. Inserir API keys
INSERT INTO sync_api_keys (api_key, tenant_id, establishment_code, description, active) VALUES
('cliente-a-key-12345', 'cliente-a', 'EST-A-001', 'Sincronizador Alpha', TRUE),
('cliente-b-key-12345', 'cliente-b', 'EST-B-001', 'Sincronizador Beta', TRUE),
('cliente-c-key-12345', 'cliente-c', 'EST-C-001', 'Sincronizador Gamma', TRUE)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- 7. Criar schemas por cliente
CREATE DATABASE IF NOT EXISTS schema_cliente_a CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS schema_cliente_b CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS schema_cliente_c CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 8. Criar tabelas básicas - Cliente A
USE schema_cliente_a;

CREATE TABLE IF NOT EXISTS tb_customer (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tb_brand (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tb_financial (
  id INT PRIMARY KEY,
  amount DECIMAL(10, 2),
  description VARCHAR(255),
  type VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. Criar tabelas básicas - Cliente B
USE schema_cliente_b;

CREATE TABLE IF NOT EXISTS tb_customer (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tb_brand (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tb_financial (
  id INT PRIMARY KEY,
  amount DECIMAL(10, 2),
  description VARCHAR(255),
  type VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. Criar tabelas básicas - Cliente C
USE schema_cliente_c;

CREATE TABLE IF NOT EXISTS tb_customer (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tb_brand (
  id INT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tb_financial (
  id INT PRIMARY KEY,
  amount DECIMAL(10, 2),
  description VARCHAR(255),
  type VARCHAR(20),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. Dados de teste para Cliente A
USE schema_cliente_a;
INSERT INTO tb_customer (id, name, email) VALUES
(1, 'Cliente A - João Silva', 'joao@clientea.com'),
(2, 'Cliente A - Maria Santos', 'maria@clientea.com');

INSERT INTO tb_brand (id, name) VALUES
(1, 'Marca Alpha'),
(2, 'Marca Beta');

-- 12. Dados de teste para Cliente B
USE schema_cliente_b;
INSERT INTO tb_customer (id, name, email) VALUES
(1, 'Cliente B - Pedro Costa', 'pedro@clienteb.com'),
(2, 'Cliente B - Ana Silva', 'ana@clienteb.com');

INSERT INTO tb_brand (id, name) VALUES
(1, 'Marca Gamma'),
(2, 'Marca Delta');

-- 13. Dados de teste para Cliente C
USE schema_cliente_c;
INSERT INTO tb_customer (id, name, email) VALUES
(1, 'Cliente C - Roberto Lima', 'roberto@clientec.com'),
(2, 'Cliente C - Fernanda Gomes', 'fernanda@clientec.com');

INSERT INTO tb_brand (id, name) VALUES
(1, 'Marca Epsilon'),
(2, 'Marca Zeta');

-- 14. Verificação final
USE setes_central;
SELECT 'Tenants cadastrados:' as info;
SELECT id, name, schema_name FROM tenants WHERE active = TRUE;

SELECT 'API Keys cadastradas:' as info;
SELECT id, api_key, tenant_id, active FROM sync_api_keys WHERE active = TRUE;

SELECT 'Setup concluído com sucesso!' as status;
