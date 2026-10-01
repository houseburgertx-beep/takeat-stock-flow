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
