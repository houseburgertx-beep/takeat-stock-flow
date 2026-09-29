import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { initializeDatabase } from './schema.ts';
import type {
  Insumo,
  Produto,
  Complemento,
  FichaTecnicaProdutoItem,
  FichaTecnicaComplementoItem,
  MovimentacaoEstoque,
  PedidoProcessado,
  AlertaEstoque,
  TipoMovimentacao,
  UnidadeMedida,
  CategoriaInsumo,
} from '../types/index.ts';

let globalDb: DatabaseSync | null = null;

export function getDatabase(dbPath: string = process.env.DATABASE_PATH || './data/estoque.db'): DatabaseSync {
  if (globalDb) return globalDb;

  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbPath);
  initializeDatabase(db);
  globalDb = db;
  return db;
}

export function closeDatabase(): void {
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
}

// ==========================================
// INSUMOS & BEBIDAS
// ==========================================

export function getAllInsumos(db: DatabaseSync, categoria?: string): Insumo[] {
  let query = 'SELECT * FROM insumos';
  const params: any[] = [];
  if (categoria) {
    query += ' WHERE categoria = ?';
    params.push(categoria);
  }
  query += ' ORDER BY nome ASC';
  return db.prepare(query).all(...params) as unknown as Insumo[];
}

export function getInsumoById(db: DatabaseSync, id: number): Insumo | undefined {
  const row = db.prepare('SELECT * FROM insumos WHERE id = ?').get(id);
  return row ? (row as unknown as Insumo) : undefined;
}

export function getInsumoByCodigo(db: DatabaseSync, codigo: string): Insumo | undefined {
  const row = db.prepare('SELECT * FROM insumos WHERE codigo = ?').get(codigo);
  return row ? (row as unknown as Insumo) : undefined;
}

export function createInsumo(
  db: DatabaseSync,
  data: {
    codigo?: string;
    nome: string;
    categoria: CategoriaInsumo;
    unidade: UnidadeMedida;
    quantidade: number;
    estoque_minimo: number;
    estoque_ideal?: number;
    preco_unitario?: number;
    is_master?: number;
  }
): Insumo {
  const now = new Date().toISOString();
  const codigo = data.codigo || `INS-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

  const stmt = db.prepare(`
    INSERT INTO insumos (
      codigo, nome, categoria, unidade, quantidade,
      estoque_minimo, estoque_ideal, preco_unitario, is_master,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
    codigo,
    data.nome,
    data.categoria,
    data.unidade,
    data.quantidade,
    data.estoque_minimo,
    data.estoque_ideal || 0,
    data.preco_unitario || 0,
    data.is_master || 0,
    now,
    now
  );

  const id = Number(res.lastInsertRowid);

  // Registro inicial no ledger
  if (data.quantidade !== 0) {
    db.prepare(`
      INSERT INTO movimentacoes_estoque (
        insumo_id, tipo, quantidade, saldo_anterior, saldo_posterior,
        referencia_tipo, referencia_id, descricao, data_hora
      ) VALUES (?, 'ENTRADA_COMPRA', ?, 0, ?, 'MANUAL', 'INICIAL', 'Saldo inicial de cadastro', ?)
    `).run(id, data.quantidade, data.quantidade, now);
  }

  return getInsumoById(db, id)!;
}

export function updateInsumo(db: DatabaseSync, id: number, data: Partial<Insumo>): void {
  const fields: string[] = [];
  const params: any[] = [];
  const allowed = ['nome', 'categoria', 'unidade', 'estoque_minimo', 'estoque_ideal', 'preco_unitario', 'is_master'];

  for (const key of allowed) {
    if (key in data) {
      fields.push(`${key} = ?`);
      params.push((data as any)[key]);
    }
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE insumos SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * Atualiza o saldo do insumo e registra imutavelmente no Ledger
 */
export function movimentarEstoque(
  db: DatabaseSync,
  insumoId: number,
  deltaQuantidade: number, // Positivo para entrada, Negativo para saída
  tipo: TipoMovimentacao,
  referenciaTipo: 'PEDIDO' | 'MANUAL' | 'SYNC',
  referenciaId: string,
  descricao: string
): MovimentacaoEstoque {
  const insumo = getInsumoById(db, insumoId);
  if (!insumo) {
    throw new Error(`Insumo ID ${insumoId} não encontrado.`);
  }

  const saldoAnterior = insumo.quantidade;
  const saldoPosterior = Number((saldoAnterior + deltaQuantidade).toFixed(4));
  const now = new Date().toISOString();

  // Atualiza insumo
  db.prepare('UPDATE insumos SET quantidade = ?, updated_at = ? WHERE id = ?').run(
    saldoPosterior,
    now,
    insumoId
  );

  // Registra no Ledger
  const res = db.prepare(`
    INSERT INTO movimentacoes_estoque (
      insumo_id, tipo, quantidade, saldo_anterior, saldo_posterior,
      referencia_tipo, referencia_id, descricao, data_hora
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    insumoId,
    tipo,
    deltaQuantidade,
    saldoAnterior,
    saldoPosterior,
    referenciaTipo,
    referenciaId,
    descricao,
    now
  );

  return {
    id: Number(res.lastInsertRowid),
    insumo_id: insumoId,
    insumo_nome: insumo.nome,
    tipo,
    quantidade: deltaQuantidade,
    saldo_anterior: saldoAnterior,
    saldo_posterior: saldoPosterior,
    referencia_tipo: referenciaTipo,
    referencia_id: referenciaId,
    descricao,
    data_hora: now,
  };
}

export function getAlertasEstoque(db: DatabaseSync): AlertaEstoque[] {
  const rows = db.prepare(`
    SELECT
      id as insumo_id,
      nome as insumo_nome,
      categoria,
      unidade,
      quantidade as saldo_atual,
      estoque_minimo,
      (estoque_minimo - quantidade) as deficit,
      CASE
        WHEN quantidade <= 0 THEN 'CRITICO'
        ELSE 'ALERTA'
      END as nivel_alerta
    FROM insumos
    WHERE quantidade <= estoque_minimo AND estoque_minimo > 0
    ORDER BY deficit DESC
  `).all();

  return rows as unknown as AlertaEstoque[];
}

// ==========================================
// PRODUTOS & COMPLEMENTOS
// ==========================================

export function upsertProduto(db: DatabaseSync, produto: Produto): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO produtos (id, nome, categoria_nome, preco, ativo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      nome = excluded.nome,
      categoria_nome = excluded.categoria_nome,
      preco = excluded.preco,
      ativo = excluded.ativo,
      updated_at = excluded.updated_at
  `).run(produto.id, produto.nome, produto.categoria_nome, produto.preco, produto.ativo, now);
}

export function getAllProdutos(db: DatabaseSync): (Produto & { tem_ficha: boolean; qtd_insumos: number })[] {
  const rows = db.prepare(`
    SELECT
      p.*,
      CASE WHEN count(ftp.id) > 0 THEN 1 ELSE 0 END as tem_ficha,
      count(ftp.id) as qtd_insumos
    FROM produtos p
    LEFT JOIN fichas_tecnicas_produtos ftp ON ftp.produto_id = p.id
    GROUP BY p.id
    ORDER BY p.categoria_nome ASC, p.nome ASC
  `).all();

  return rows.map((r: any) => ({
    ...r,
    tem_ficha: Boolean(r.tem_ficha),
  }));
}

export function upsertComplemento(db: DatabaseSync, complemento: Complemento): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO complementos (id, nome, categoria_nome, preco, ativo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      nome = excluded.nome,
      categoria_nome = excluded.categoria_nome,
      preco = excluded.preco,
      ativo = excluded.ativo,
      updated_at = excluded.updated_at
  `).run(complemento.id, complemento.nome, complemento.categoria_nome, complemento.preco, complemento.ativo, now);
}

export function getAllComplementos(db: DatabaseSync): (Complemento & { tem_ficha: boolean; qtd_insumos: number })[] {
  const rows = db.prepare(`
    SELECT
      c.*,
      CASE WHEN count(ftc.id) > 0 THEN 1 ELSE 0 END as tem_ficha,
      count(ftc.id) as qtd_insumos
    FROM complementos c
    LEFT JOIN fichas_tecnicas_complementos ftc ON ftc.complemento_id = c.id
    GROUP BY c.id
    ORDER BY c.categoria_nome ASC, c.nome ASC
  `).all();

  return rows.map((r: any) => ({
    ...r,
    tem_ficha: Boolean(r.tem_ficha),
  }));
}

// ==========================================
// FICHAS TÉCNICAS (BOM)
// ==========================================

export function getFichaTecnicaProduto(db: DatabaseSync, produtoId: number): FichaTecnicaProdutoItem[] {
  const rows = db.prepare(`
    SELECT
      ftp.id,
      ftp.produto_id,
      ftp.insumo_id,
      i.nome as insumo_nome,
      i.unidade as insumo_unidade,
      i.quantidade as insumo_estoque,
      ftp.quantidade_consumida,
      ftp.unidade_consumida,
      ftp.created_at
    FROM fichas_tecnicas_produtos ftp
    JOIN insumos i ON i.id = ftp.insumo_id
    WHERE ftp.produto_id = ?
    ORDER BY i.nome ASC
  `).all(produtoId);

  return rows as unknown as FichaTecnicaProdutoItem[];
}

export function saveFichaTecnicaProduto(
  db: DatabaseSync,
  produtoId: number,
  itens: { insumo_id: number; quantidade_consumida: number; unidade_consumida: string }[]
): void {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM fichas_tecnicas_produtos WHERE produto_id = ?').run(produtoId);

  const insert = db.prepare(`
    INSERT INTO fichas_tecnicas_produtos (produto_id, insumo_id, quantidade_consumida, unidade_consumida, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const item of itens) {
    insert.run(produtoId, item.insumo_id, item.quantidade_consumida, item.unidade_consumida, now);
  }
}

export function getFichaTecnicaComplemento(db: DatabaseSync, complementoId: number): FichaTecnicaComplementoItem[] {
  const rows = db.prepare(`
    SELECT
      ftc.id,
      ftc.complemento_id,
      ftc.insumo_id,
      i.nome as insumo_nome,
      i.unidade as insumo_unidade,
      i.quantidade as insumo_estoque,
      ftc.quantidade_consumida,
      ftc.unidade_consumida,
      ftc.created_at
    FROM fichas_tecnicas_complementos ftc
    JOIN insumos i ON i.id = ftc.insumo_id
    WHERE ftc.complemento_id = ?
    ORDER BY i.nome ASC
  `).all(complementoId);

  return rows as unknown as FichaTecnicaComplementoItem[];
}

export function saveFichaTecnicaComplemento(
  db: DatabaseSync,
  complementoId: number,
  itens: { insumo_id: number; quantidade_consumida: number; unidade_consumida: string }[]
): void {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM fichas_tecnicas_complementos WHERE complemento_id = ?').run(complementoId);

  const insert = db.prepare(`
    INSERT INTO fichas_tecnicas_complementos (complemento_id, insumo_id, quantidade_consumida, unidade_consumida, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  for (const item of itens) {
    insert.run(complementoId, item.insumo_id, item.quantidade_consumida, item.unidade_consumida, now);
  }
}

// ==========================================
// VENDAS & PEDIDOS PROCESSADOS (IDEMPOTÊNCIA)
// ==========================================

export function isOrderProcessed(db: DatabaseSync, orderId: number): boolean {
  const row = db.prepare('SELECT id FROM pedidos_processados WHERE order_id = ?').get(orderId);
  return Boolean(row);
}

export function savePedidoProcessado(
  db: DatabaseSync,
  pedido: PedidoProcessado,
  complementos: { complemento_id: number; complemento_nome: string; quantidade: number }[]
): number {
  const stmt = db.prepare(`
    INSERT INTO pedidos_processados (
      order_id, session_id, basket_id, produto_id, produto_nome,
      quantidade, preco_total, canal, comanda_numero, mesa_numero,
      data_pedido, data_processamento
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const res = stmt.run(
    pedido.order_id,
    pedido.session_id,
    pedido.basket_id,
    pedido.produto_id,
    pedido.produto_nome,
    pedido.quantidade,
    pedido.preco_total,
    pedido.canal,
    pedido.comanda_numero,
    pedido.mesa_numero,
    pedido.data_pedido,
    pedido.data_processamento
  );

  const pedidoId = Number(res.lastInsertRowid);

  if (complementos.length > 0) {
    const insertComp = db.prepare(`
      INSERT INTO pedidos_complementos_processados (pedido_processado_id, complemento_id, complemento_nome, quantidade)
      VALUES (?, ?, ?, ?)
    `);
    for (const comp of complementos) {
      insertComp.run(pedidoId, comp.complemento_id, comp.complemento_nome, comp.quantidade);
    }
  }

  return pedidoId;
}

export function getPedidosProcessados(db: DatabaseSync, limit = 50, offset = 0): any[] {
  const pedidos = db.prepare(`
    SELECT * FROM pedidos_processados ORDER BY data_pedido DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as unknown as PedidoProcessado[];

  return pedidos.map((p) => {
    const compRows = db.prepare(`
      SELECT complemento_id, complemento_nome, quantidade
      FROM pedidos_complementos_processados
      WHERE pedido_processado_id = ?
    `).all(p.id!);

    const deducoes = db.prepare(`
      SELECT m.id, m.quantidade, m.descricao, i.nome as insumo_nome, i.unidade as insumo_unidade
      FROM movimentacoes_estoque m
      JOIN insumos i ON i.id = m.insumo_id
      WHERE m.referencia_tipo = 'PEDIDO' AND m.referencia_id = ?
    `).all(String(p.order_id));

    return {
      ...p,
      complementos: compRows,
      deducoes_estoque: deducoes,
    };
  });
}

// ==========================================
// MOVIMENTAÇÕES & LEDGER
// ==========================================

export function getMovimentacoes(db: DatabaseSync, limit = 100): MovimentacaoEstoque[] {
  const rows = db.prepare(`
    SELECT
      m.id,
      m.insumo_id,
      i.nome as insumo_nome,
      i.unidade as insumo_unidade,
      m.tipo,
      m.quantidade,
      m.saldo_anterior,
      m.saldo_posterior,
      m.referencia_tipo,
      m.referencia_id,
      m.descricao,
      m.data_hora
    FROM movimentacoes_estoque m
    JOIN insumos i ON i.id = m.insumo_id
    ORDER BY m.id DESC
    LIMIT ?
  `).all(limit);

  return rows as unknown as MovimentacaoEstoque[];
}

// ==========================================
// TOKEN CACHE
// ==========================================

export function getTokenCache(db: DatabaseSync): { access_token: string; refresh_token: string; expires_at: number; scope: string } | null {
  const row = db.prepare('SELECT access_token, refresh_token, expires_at, scope FROM token_cache WHERE id = 1').get();
  return row ? (row as any) : null;
}

export function saveTokenCache(
  db: DatabaseSync,
  access_token: string,
  refresh_token: string,
  expires_at: number,
  scope: string
): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO token_cache (id, access_token, refresh_token, expires_at, scope, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      updated_at = excluded.updated_at
  `).run(access_token, refresh_token, expires_at, scope, now);
}

// ==========================================
// SYNC LOGS
// ==========================================

export function addSyncLog(db: DatabaseSync, tipo: string, status: string, detalhes?: string): void {
  db.prepare(`
    INSERT INTO sync_logs (tipo, status, detalhes, data_hora)
    VALUES (?, ?, ?, ?)
  `).run(tipo, status, detalhes || null, new Date().toISOString());
}

export function getRecentSyncLogs(db: DatabaseSync, limit = 10): any[] {
  return db.prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?').all(limit);
}
