import { DatabaseSync } from 'node:sqlite';

export function initializeDatabase(db: DatabaseSync): void {
  // Otimizações de desempenho e integridade
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    -- Tabela de Insumos e Bebidas
    CREATE TABLE IF NOT EXISTS insumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE,
      nome TEXT NOT NULL,
      categoria TEXT NOT NULL DEFAULT 'insumo', -- 'bebida', 'insumo', 'alimento', 'embalagem'
      unidade TEXT NOT NULL,                    -- 'un', 'ml', 'l', 'g', 'kg'
      quantidade REAL NOT NULL DEFAULT 0,       -- Saldo atual em estoque
      estoque_minimo REAL NOT NULL DEFAULT 0,   -- Ponto de alerta para reposição
      estoque_ideal REAL DEFAULT 0,
      preco_unitario REAL DEFAULT 0,
      is_master INTEGER DEFAULT 0,              -- 1 se representa estoque direto de produto
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_insumos_categoria ON insumos(categoria);
    CREATE INDEX IF NOT EXISTS idx_insumos_nome ON insumos(nome);

    -- Tabela de Produtos (sincronizados do catálogo Takeat)
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY, -- ID oficial do produto na Takeat
      nome TEXT NOT NULL,
      categoria_nome TEXT,
      preco REAL DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    -- Tabela de Complementos (sincronizados do catálogo Takeat)
    CREATE TABLE IF NOT EXISTS complementos (
      id INTEGER PRIMARY KEY, -- ID oficial do complemento na Takeat
      nome TEXT NOT NULL,
      categoria_nome TEXT,
      preco REAL DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    -- Ficha Técnica de Produtos (BOM de Produtos: quais insumos cada produto consome)
    CREATE TABLE IF NOT EXISTS fichas_tecnicas_produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      quantidade_consumida REAL NOT NULL,
      unidade_consumida TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (produto_id) REFERENCES produtos(id) ON DELETE CASCADE,
      FOREIGN KEY (insumo_id) REFERENCES insumos(id) ON DELETE CASCADE,
      UNIQUE(produto_id, insumo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ftp_produto ON fichas_tecnicas_produtos(produto_id);

    -- Ficha Técnica de Complementos (BOM de Complementos/Adicionais: quais insumos o complemento consome)
    CREATE TABLE IF NOT EXISTS fichas_tecnicas_complementos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complemento_id INTEGER NOT NULL,
      insumo_id INTEGER NOT NULL,
      quantidade_consumida REAL NOT NULL,
      unidade_consumida TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (complemento_id) REFERENCES complementos(id) ON DELETE CASCADE,
      FOREIGN KEY (insumo_id) REFERENCES insumos(id) ON DELETE CASCADE,
      UNIQUE(complemento_id, insumo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ftc_complemento ON fichas_tecnicas_complementos(complemento_id);

    -- Pedidos Processados (Garante IDEMPOTÊNCIA: nunca deduzir duas vezes a mesma venda)
    CREATE TABLE IF NOT EXISTS pedidos_processados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL UNIQUE, -- ID único do pedido na Takeat
      session_id INTEGER NOT NULL,      -- ID da comanda/sessão de mesa
      basket_id TEXT,
      produto_id INTEGER NOT NULL,
      produto_nome TEXT NOT NULL,
      quantidade INTEGER NOT NULL,
      preco_total REAL,
      canal TEXT,
      comanda_numero TEXT,
      mesa_numero TEXT,
      data_pedido TEXT NOT NULL,
      data_processamento TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pedidos_order_id ON pedidos_processados(order_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_data_pedido ON pedidos_processados(data_pedido);

    -- Complementos de Pedidos Processados
    CREATE TABLE IF NOT EXISTS pedidos_complementos_processados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_processado_id INTEGER NOT NULL,
      complemento_id INTEGER NOT NULL,
      complemento_nome TEXT NOT NULL,
      quantidade INTEGER NOT NULL,
      FOREIGN KEY (pedido_processado_id) REFERENCES pedidos_processados(id) ON DELETE CASCADE
    );

    -- Ledger de Movimentações de Estoque (Auditoria Imutável)
    CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      insumo_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,            -- 'SAIDA_VENDA', 'ENTRADA_COMPRA', 'AJUSTE_INVENTARIO', 'PERDA'
      quantidade REAL NOT NULL,      -- Negativo para saída, Positivo para entrada
      saldo_anterior REAL NOT NULL,
      saldo_posterior REAL NOT NULL,
      referencia_tipo TEXT,          -- 'PEDIDO', 'MANUAL', 'SYNC'
      referencia_id TEXT,            -- ID do pedido Takeat ou nota
      descricao TEXT,
      data_hora TEXT NOT NULL,
      FOREIGN KEY (insumo_id) REFERENCES insumos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mov_insumo ON movimentacoes_estoque(insumo_id);
    CREATE INDEX IF NOT EXISTS idx_mov_data ON movimentacoes_estoque(data_hora);

    -- Cache seguro de tokens OAuth (apenas 1 registro)
    CREATE TABLE IF NOT EXISTS token_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL, -- Unix timestamp em ms
      scope TEXT,
      updated_at TEXT NOT NULL
    );

    -- Log de sincronização Takeat
    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,            -- 'INSUMOS', 'CATALOGO', 'VENDAS'
      status TEXT NOT NULL,          -- 'SUCCESS', 'ERROR'
      detalhes TEXT,
      data_hora TEXT NOT NULL
    );
  `);
}
