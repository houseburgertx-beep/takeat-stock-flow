import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/db/schema.ts';
import {
  getOrCreateContagemHoje,
  adicionarProdutoContagem,
  atualizarItemContagem,
  removerProdutoContagem,
  listarHistoricoContagens
} from '../src/db/database.ts';

test('Contagem: criação, adição, edição de nome/dados e recálculo de divergência', () => {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);

  // 1. Criar folha de contagem para o dia 2026-09-30
  const contagem = getOrCreateContagemHoje(db, '2026-09-30');
  assert.ok(contagem.id, 'Folha de contagem deve ter id');
  assert.ok(contagem.itens.length > 0, 'Folha de contagem deve inicializar com itens padrão');

  // 2. Adicionar um novo produto na folha
  const novoItem = adicionarProdutoContagem(db, contagem.id, 'Cerveja Original 600ml');
  assert.strictEqual(novoItem.nome_produto, 'CERVEJA ORIGINAL 600ML');
  assert.strictEqual(novoItem.pre_venda, 0);

  // 3. Editar o nome e os valores do produto
  const itemAtualizado = atualizarItemContagem(db, novoItem.id, {
    nome_produto: 'Cerveja Original 600ml Garrafa',
    pre_venda: 24,
    entrada_estoque: 12,
    venda: 10,
    pos_venda: 25,
    verificado: true
  });

  assert.strictEqual(itemAtualizado.nome_produto, 'CERVEJA ORIGINAL 600ML GARRAFA');
  assert.strictEqual(itemAtualizado.pre_venda, 24);
  assert.strictEqual(itemAtualizado.entrada_estoque, 12);
  assert.strictEqual(itemAtualizado.venda, 10);
  assert.strictEqual(itemAtualizado.pos_venda, 25);
  // divergencia esperada: (24 + 12 - 10) - 25 = 26 - 25 = 1 (falta 1)
  assert.strictEqual(itemAtualizado.divergencia, 1);
  assert.strictEqual(itemAtualizado.verificado, 1);

  // 4. Remover produto da folha
  removerProdutoContagem(db, novoItem.id);
  const contagemAposRemocao = getOrCreateContagemHoje(db, '2026-09-30');
  const existe = contagemAposRemocao.itens.some((i: any) => i.id === novoItem.id);
  assert.strictEqual(existe, false, 'Item deve ter sido removido');

  // 5. Histórico
  const historico = listarHistoricoContagens(db);
  assert.ok(historico.length >= 1, 'Deve listar pelo menos uma folha no histórico');
});

test('Contagem: importarBebidasCardapioTakeat importa catálogo e configura vínculos automáticos', () => {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);

  // Insere produtos e complementos do cardápio Takeat
  db.prepare(`
    INSERT INTO produtos (id, nome, categoria_nome, preco, ativo, updated_at) VALUES
    (101, 'Coca-Cola Lata 350ml', 'REFRIGERANTES', 6.5, 1, ''),
    (102, 'Pepsi 1L', 'REFRIGERANTES', 9.99, 1, ''),
    (103, 'Cerveja Heineken 600ml', 'CERVEJAS', 15.0, 1, ''),
    (104, 'X-tudo + refri mini 200ml', 'BURGER', 25.0, 1, ''),
    (105, 'Suco de Laranja 500 Ml', 'SUCOS', 8.0, 1, '')
  `).run();

  db.prepare(`
    INSERT INTO complementos (id, nome, categoria_nome, preco, ativo, updated_at) VALUES
    (201, 'REFRI MINI 200ML', 'Opções', 0, 1, ''),
    (202, 'pepsi lata zero', 'escolha o refrigerante', 0, 1, '')
  `).run();

  const contagem = getOrCreateContagemHoje(db, '2026-10-05');
  const itens = contagem.itens;

  // Deve ter agrupado e excluído o suco
  const nomes = itens.map((i: any) => i.nome_produto);
  assert.ok(nomes.includes('COCA COLA LATA 350ML'), 'Deve conter COCA COLA LATA 350ML');
  assert.ok(nomes.includes('PEPSI 1L'), 'Deve conter PEPSI 1L');
  assert.ok(nomes.includes('CERVEJA HEINEKEN 600ML'), 'Deve conter CERVEJA HEINEKEN 600ML');
  assert.ok(nomes.includes('REFRI MINI 200ML'), 'Deve conter REFRI MINI 200ML');
  assert.ok(!nomes.some((n: string) => n.includes('SUCO')), 'Não deve incluir sucos');

  // Vínculos automáticos devem estar presentes no REFRI MINI 200ML
  const itemMini = itens.find((i: any) => i.nome_produto === 'REFRI MINI 200ML');
  assert.ok(itemMini, 'Item REFRI MINI deve existir');
  const vinculos = JSON.parse(itemMini.vinculos_takeat || '[]');
  assert.ok(vinculos.includes('REFRI MINI 200ML') || vinculos.includes('X-tudo + refri mini 200ml'));
});

