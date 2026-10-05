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

export function clearTokenCache(db: DatabaseSync): void {
  db.prepare('DELETE FROM token_cache').run();
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

// ==========================================
// CONTAGEM DIÁRIA DE ESTOQUE (PLANILHA)
// ==========================================

export const ITENS_PADRAO_PLANILHA = [
  'KUAT 1L',
  'AGUA MINERAL C/GÁS 500ML',
  'AGUA MINERAL S/GÁS 500ML',
  'COCA COLA PET 1L',
  'FANTA LARANJA 1L',
  'FANTA LARANJA LATA 350ML',
  'FANTA UVA LATA 350ML',
  'GUARANÁ LATA 350ML',
  'GUARANÁ PET 1LT',
  'SPRITE LATA 350ML',
  'COCA COLA LATA 350ML',
  'COCA COLA LATA S/A 350ML',
  'COCA COLA PET 600ML',
  'COCA COLA PET S/A 1LT',
  'COCA COLA PET 250ML',
];

export function getOrCreateContagemHoje(db: DatabaseSync, dataParam?: string): any {
  const dataStr = dataParam || new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  let contagem = db.prepare('SELECT * FROM contagens_diarias WHERE data = ?').get(dataStr) as any;

  if (!contagem) {
    // Busca última contagem finalizada para herdar o saldo de ontem como pré-venda de hoje
    const ultima = db.prepare('SELECT id FROM contagens_diarias ORDER BY data DESC LIMIT 1').get() as any;
    let saldosOntem: Record<string, number> = {};
    if (ultima) {
      const itensOntem = db.prepare('SELECT nome_produto, pos_venda FROM contagem_itens WHERE contagem_id = ?').all(ultima.id) as any[];
      for (const io of itensOntem) {
        saldosOntem[io.nome_produto] = io.pos_venda || 0;
      }
    }

    const res = db.prepare(`
      INSERT INTO contagens_diarias (data, pizzaria, responsavel, hora_inicial, hora_final, status, created_at, updated_at)
      VALUES (?, 'PIZZARIA', '', '', '', 'ABERTO', ?, ?)
    `).run(dataStr, now, now);

    const contagemId = Number(res.lastInsertRowid);

    // Inserir itens padrão ou insumos cadastrados
    const insumosExistentes = getAllInsumos(db);
    const listaNomes = new Set<string>();

    // Adiciona os itens da planilha
    ITENS_PADRAO_PLANILHA.forEach(nome => listaNomes.add(nome));
    // Adiciona bebidas do banco se houver
    insumosExistentes.filter(i => i.categoria === 'bebida').forEach(i => listaNomes.add(i.nome.toUpperCase()));

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO contagem_itens (contagem_id, nome_produto, pre_venda, entrada_estoque, venda, pos_venda, divergencia, verificado)
      VALUES (?, ?, ?, 0, 0, ?, 0, 0)
    `);

    for (const nome of listaNomes) {
      const preVenda = saldosOntem[nome] ?? (nome === 'KUAT 1L' ? 10 : nome === 'AGUA MINERAL S/GÁS 500ML' ? 25 : 0);
      const posVenda = saldosOntem[nome] ?? (nome === 'KUAT 1L' ? 5 : nome === 'AGUA MINERAL S/GÁS 500ML' ? 18 : 0);
      const venda = nome === 'KUAT 1L' ? 5 : nome === 'AGUA MINERAL S/GÁS 500ML' ? 10 : 0;
      const entrada = nome === 'AGUA MINERAL S/GÁS 500ML' ? 5 : 0;
      const divergencia = (preVenda + entrada - venda) - posVenda;
      const verificado = nome === 'KUAT 1L' ? 1 : 0;

      db.prepare(`
        INSERT OR IGNORE INTO contagem_itens (contagem_id, nome_produto, pre_venda, entrada_estoque, venda, pos_venda, divergencia, verificado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(contagemId, nome, preVenda, entrada, venda, posVenda, divergencia, verificado);
    }

    contagem = db.prepare('SELECT * FROM contagens_diarias WHERE id = ?').get(contagemId) as any;
  }

  const itens = db.prepare('SELECT * FROM contagem_itens WHERE contagem_id = ? ORDER BY id ASC').all(contagem.id);
  return { ...contagem, itens };
}

export function atualizarItemContagem(
  db: DatabaseSync,
  itemId: number,
  fields: {
    nome_produto?: string;
    pre_venda?: number;
    entrada_estoque?: number;
    venda?: number;
    pos_venda?: number;
    verificado?: boolean | number;
    vinculos_takeat?: string | string[];
  }
): any {
  const item = db.prepare('SELECT * FROM contagem_itens WHERE id = ?').get(itemId) as any;
  if (!item) throw new Error('Item de contagem não encontrado');

  const nome = fields.nome_produto !== undefined && fields.nome_produto.trim()
    ? fields.nome_produto.trim().toUpperCase()
    : item.nome_produto;
  const pre = fields.pre_venda !== undefined ? Number(fields.pre_venda) : item.pre_venda;
  const entrada = fields.entrada_estoque !== undefined ? Number(fields.entrada_estoque) : item.entrada_estoque;
  const venda = fields.venda !== undefined ? Number(fields.venda) : item.venda;
  const pos = fields.pos_venda !== undefined ? Number(fields.pos_venda) : item.pos_venda;
  const verificado = fields.verificado !== undefined ? (fields.verificado ? 1 : 0) : item.verificado;
  const vinculos = fields.vinculos_takeat !== undefined
    ? (typeof fields.vinculos_takeat === 'string' ? fields.vinculos_takeat : JSON.stringify(fields.vinculos_takeat))
    : (item.vinculos_takeat || '[]');

  const divergencia = (pre + entrada - venda) - pos;

  db.prepare(`
    UPDATE contagem_itens
    SET nome_produto = ?, pre_venda = ?, entrada_estoque = ?, venda = ?, pos_venda = ?, divergencia = ?, verificado = ?, vinculos_takeat = ?
    WHERE id = ?
  `).run(nome, pre, entrada, venda, pos, divergencia, verificado, vinculos, itemId);

  return db.prepare('SELECT * FROM contagem_itens WHERE id = ?').get(itemId);
}

export function atualizarCabecalhoContagem(
  db: DatabaseSync,
  contagemId: number,
  dados: { pizzaria?: string; responsavel?: string; hora_inicial?: string; hora_final?: string; status?: string }
): any {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE contagens_diarias
    SET pizzaria = COALESCE(?, pizzaria),
        responsavel = COALESCE(?, responsavel),
        hora_inicial = COALESCE(?, hora_inicial),
        hora_final = COALESCE(?, hora_final),
        status = COALESCE(?, status),
        updated_at = ?
    WHERE id = ?
  `).run(dados.pizzaria ?? null, dados.responsavel ?? null, dados.hora_inicial ?? null, dados.hora_final ?? null, dados.status ?? null, now, contagemId);

  return db.prepare('SELECT * FROM contagens_diarias WHERE id = ?').get(contagemId);
}

export function adicionarProdutoContagem(db: DatabaseSync, contagemId: number, nomeProduto: string): any {
  const nome = nomeProduto.trim().toUpperCase();
  if (!nome) throw new Error('Nome do produto é obrigatório');

  db.prepare(`
    INSERT OR IGNORE INTO contagem_itens (contagem_id, nome_produto, pre_venda, entrada_estoque, venda, pos_venda, divergencia, verificado)
    VALUES (?, ?, 0, 0, 0, 0, 0, 0)
  `).run(contagemId, nome);

  return db.prepare('SELECT * FROM contagem_itens WHERE contagem_id = ? AND nome_produto = ?').get(contagemId, nome);
}

export function removerProdutoContagem(db: DatabaseSync, itemId: number): void {
  db.prepare('DELETE FROM contagem_itens WHERE id = ?').run(itemId);
}

export function listarHistoricoContagens(db: DatabaseSync): any[] {
  return db.prepare(`
    SELECT cd.*, 
           COUNT(ci.id) as total_itens,
           SUM(CASE WHEN ci.divergencia != 0 THEN 1 ELSE 0 END) as total_divergencias,
           SUM(ci.venda) as total_vendas
    FROM contagens_diarias cd
    LEFT JOIN contagem_itens ci ON cd.id = ci.contagem_id
    GROUP BY cd.id
    ORDER BY cd.data DESC
    LIMIT 30
  `).all();
}

// ==========================================
// DETECÇÃO DE BEBIDAS E BUSCA GLOBAL
// ==========================================

export const CATEGORIAS_BEBIDAS_TAKET = [
  'refrigerante', 'refrigerantes', 'cerveja', 'cervejas', 'chopp', 'escolha o refrigerante', 'refri'
];

export const TERMOS_EXCLUSAO_BEBIDAS = [
  'drink', 'drinks', 'suco', 'sucos', 'limonada', 'pink lemon', 'caipirinha',
  'caipicerva', 'gin', 'vodka', 'coquetel', 'ice tea', 'cha', 'chá', 'mate', 'matte'
];

export const PALAVRAS_CHAVE_BEBIDAS = [
  'coca', 'coca-cola', 'pepsi', 'kuat', 'fanta', 'sprite', 'guarana', 'guaraná',
  'heineken', 'budweiser', 'amstel', 'brahma', 'skol', 'chopp', 'corona',
  'stella', 'spaten', 'eisenbahn', 'becks', 'beck', 'bohemia', 'cerveja',
  'michelob', 'beats senses', 'red bull', 'monster', 'energetico', 'energético',
  'gatorade', 'h2oh', 'h2o', 'schweppes', 'tonica', 'tônica', 'refri', 'refrigerante',
  'agua', 'água'
];

export interface ClassificacaoItem {
  isBebida: boolean;
  subtipo: 'BEBIDA' | 'COMBO_COM_BEBIDA' | 'OUTROS';
  categoriaBebida?: 'REFRIGERANTE' | 'CERVEJA' | 'AGUA' | 'ENERGETICO' | 'OUTRO';
  motivo?: string;
}

export function classificarItemCatalogo(nome: string, categoria?: string, tipo: 'PRODUTO' | 'COMPLEMENTO' = 'PRODUTO'): ClassificacaoItem {
  const n = (nome || '').trim();
  const nLow = n.toLowerCase();
  const c = (categoria || '').trim();
  const cLow = c.toLowerCase();

  // 1. Excluir modificadores de ingredientes
  if (nLow.startsWith('retirar ') || nLow.startsWith('sem ') || cLow.startsWith('retirar ')) {
    return { isBebida: false, subtipo: 'OUTROS' };
  }

  // 2. EXCLUSÃO EXPLÍCITA: DRINKS E SUCOS (como solicitado)
  for (const exc of TERMOS_EXCLUSAO_BEBIDAS) {
    const rx = new RegExp('(^|[^a-z0-9])' + exc + '($|[^a-z0-9])', 'i');
    if (rx.test(nLow) || rx.test(cLow)) {
      return { isBebida: false, subtipo: 'OUTROS', motivo: 'Excluído: Drink ou Suco' };
    }
  }

  // 3. Checagem de palavras-chave de marcas e tipos de bebidas
  const termoEncontrado = PALAVRAS_CHAVE_BEBIDAS.find(kw => {
    const rx = new RegExp('(^|[^a-z0-9])' + kw + '($|[^a-z0-9])', 'i');
    return rx.test(nLow);
  });

  const catEhBebida = CATEGORIAS_BEBIDAS_TAKET.some(cb => cLow.includes(cb)) || (cLow === 'bebida' || cLow === 'bebidas');

  // Volumes específicos no nome (ex: 350ml, 1l, etc.)
  const volumeRx = /(350\s*ml|600\s*ml|500\s*ml|200\s*ml|330\s*ml|355\s*ml|269\s*ml|1\s*l\b|2\s*l\b|long\s*neck|\bks\b|lata\b)/i;
  const temVolume = volumeRx.test(nLow);

  // Se o item contém comidas / lanches mas também cita bebida (ex: "X-tudo + refri 200ml", "American Smash + Refri")
  const ehLancheCombo = /\b(burger|burguer|smash|coxinha|frita|fritas|bacon|costela|lanche|combo|melt|x-tudo|pizza|sanduiche|sanduíche)\b/i.test(nLow) ||
    /\b(burger|burguer|combos|lanches|pizzas)\b/i.test(cLow);

  // Determinar categoria específica (Refrigerante, Cerveja, Água, etc.)
  let catBebida: ClassificacaoItem['categoriaBebida'] = 'OUTRO';
  if (/cerveja|chopp|heineken|budweiser|amstel|brahma|skol|corona|stella|spaten|eisenbahn|becks|bohemia|michelob|beats/i.test(nLow + ' ' + cLow)) {
    catBebida = 'CERVEJA';
  } else if (/agua|água/i.test(nLow + ' ' + cLow)) {
    catBebida = 'AGUA';
  } else if (/red bull|monster|energetico|energético|gatorade/i.test(nLow + ' ' + cLow)) {
    catBebida = 'ENERGETICO';
  } else if (/coca|pepsi|guarana|guaraná|fanta|sprite|kuat|h2o|h2oh|refri|refrigerante|schweppes|tonica|tônica/i.test(nLow + ' ' + cLow)) {
    catBebida = 'REFRIGERANTE';
  }

  if (termoEncontrado || (temVolume && (catEhBebida || /refri|agua|coca|pepsi|cerveja/i.test(cLow)))) {
    if (ehLancheCombo && tipo === 'PRODUTO') {
      return {
        isBebida: true,
        subtipo: 'COMBO_COM_BEBIDA',
        categoriaBebida: catBebida,
        motivo: 'Combo com bebida inclusa'
      };
    }
    return {
      isBebida: true,
      subtipo: 'BEBIDA',
      categoriaBebida: catBebida,
      motivo: termoEncontrado ? `Termo: ${termoEncontrado}` : `Categoria: ${c || 'Bebidas'}`
    };
  }

  if (catEhBebida && !ehLancheCombo) {
    return {
      isBebida: true,
      subtipo: 'BEBIDA',
      categoriaBebida: catBebida,
      motivo: `Categoria: ${c || 'Bebidas'}`
    };
  }

  return { isBebida: false, subtipo: 'OUTROS' };
}

export function isBebidaNomeOuCategoria(nome: string, categoria?: string): boolean {
  return classificarItemCatalogo(nome, categoria).isBebida;
}

export interface ResultadoBuscaCatalogo {
  id: number;
  nome: string;
  tipo: 'PRODUTO' | 'COMPLEMENTO';
  categoria: string;
  preco: number;
  is_bebida: boolean;
  subtipo: 'BEBIDA' | 'COMBO_COM_BEBIDA' | 'OUTROS';
  categoria_bebida?: 'REFRIGERANTE' | 'CERVEJA' | 'AGUA' | 'ENERGETICO' | 'OUTRO';
  motivo_bebida?: string;
  ja_na_folha?: boolean;
}

export function buscaGlobalCatalogo(
  db: DatabaseSync,
  options?: {
    termo?: string;
    tipo?: 'TODOS' | 'PRODUTO' | 'COMPLEMENTO';
    apenasBebidas?: boolean;
    categoriaBebida?: string;
    contagemId?: number;
  }
): ResultadoBuscaCatalogo[] {
  const produtos = getAllProdutos(db);
  const complementos = getAllComplementos(db);

  const termo = (options?.termo || '').trim().toLowerCase();
  const filtroTipo = options?.tipo || 'TODOS';
  const apenasBebidas = options?.apenasBebidas ?? true;
  const filtroCatBebida = options?.categoriaBebida;

  // Itens atualmente na folha de contagem
  const nomesNaFolha = new Set<string>();
  if (options?.contagemId) {
    const itensFolha = db.prepare('SELECT nome_produto FROM contagem_itens WHERE contagem_id = ?').all(options.contagemId) as any[];
    itensFolha.forEach(i => nomesNaFolha.add(i.nome_produto.toUpperCase()));
  } else {
    // Pega das contagens recentes
    const itensFolha = db.prepare('SELECT nome_produto FROM contagem_itens ORDER BY id DESC LIMIT 50').all() as any[];
    itensFolha.forEach(i => nomesNaFolha.add(i.nome_produto.toUpperCase()));
  }

  const resultados: ResultadoBuscaCatalogo[] = [];

  if (filtroTipo === 'TODOS' || filtroTipo === 'PRODUTO') {
    for (const p of produtos) {
      const classif = classificarItemCatalogo(p.nome, p.categoria_nome, 'PRODUTO');
      if (apenasBebidas && !classif.isBebida) continue;
      if (filtroCatBebida && classif.categoriaBebida !== filtroCatBebida) continue;

      if (termo) {
        const matchNome = (p.nome || '').toLowerCase().includes(termo);
        const matchCat = (p.categoria_nome || '').toLowerCase().includes(termo);
        if (!matchNome && !matchCat) continue;
      }

      resultados.push({
        id: p.id,
        nome: p.nome,
        tipo: 'PRODUTO',
        categoria: p.categoria_nome || 'Geral',
        preco: p.preco || 0,
        is_bebida: classif.isBebida,
        subtipo: classif.subtipo,
        categoria_bebida: classif.categoriaBebida,
        motivo_bebida: classif.motivo,
        ja_na_folha: nomesNaFolha.has(p.nome.trim().toUpperCase())
      });
    }
  }

  if (filtroTipo === 'TODOS' || filtroTipo === 'COMPLEMENTO') {
    for (const c of complementos) {
      const classif = classificarItemCatalogo(c.nome, c.categoria_nome, 'COMPLEMENTO');
      if (apenasBebidas && !classif.isBebida) continue;
      if (filtroCatBebida && classif.categoriaBebida !== filtroCatBebida) continue;

      if (termo) {
        const matchNome = (c.nome || '').toLowerCase().includes(termo);
        const matchCat = (c.categoria_nome || '').toLowerCase().includes(termo);
        if (!matchNome && !matchCat) continue;
      }

      resultados.push({
        id: c.id,
        nome: c.nome,
        tipo: 'COMPLEMENTO',
        categoria: c.categoria_nome || 'Opções',
        preco: c.preco || 0,
        is_bebida: classif.isBebida,
        subtipo: classif.subtipo,
        categoria_bebida: classif.categoriaBebida,
        motivo_bebida: classif.motivo,
        ja_na_folha: nomesNaFolha.has(c.nome.trim().toUpperCase())
      });
    }
  }

  return resultados;
}

export function getBebidasTakeatCatalog(db: DatabaseSync): Array<{
  id: number;
  nome: string;
  tipo: 'PRODUTO' | 'COMPLEMENTO';
  categoria: string;
  preco: number;
  subtipo?: string;
  categoria_bebida?: string;
}> {
  const busca = buscaGlobalCatalogo(db, { apenasBebidas: true });
  return busca.map(item => ({
    id: item.id,
    nome: item.nome,
    tipo: item.tipo,
    categoria: item.categoria,
    preco: item.preco,
    subtipo: item.subtipo,
    categoria_bebida: item.categoria_bebida
  }));
}

export function vincularItensTakeat(db: DatabaseSync, itemId: number, vinculos: string[]): any {
  const jsonStr = JSON.stringify(vinculos || []);
  db.prepare('UPDATE contagem_itens SET vinculos_takeat = ? WHERE id = ?').run(jsonStr, itemId);
  return db.prepare('SELECT * FROM contagem_itens WHERE id = ?').get(itemId);
}

