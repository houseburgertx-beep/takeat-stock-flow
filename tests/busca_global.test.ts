import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/db/schema.ts';
import {
  classificarItemCatalogo,
  buscaGlobalCatalogo,
  upsertProduto,
  upsertComplemento
} from '../src/db/database.ts';

test('Detecção de Bebidas: classificação precisa excluindo drinks e sucos', () => {
  // 1. Deve classificar refrigerantes, cervejas e águas como BEBIDA
  const coca = classificarItemCatalogo('Coca-Cola Lata 350ml', 'REFRIGERANTES', 'PRODUTO');
  assert.strictEqual(coca.isBebida, true);
  assert.strictEqual(coca.subtipo, 'BEBIDA');
  assert.strictEqual(coca.categoriaBebida, 'REFRIGERANTE');

  const heineken = classificarItemCatalogo('Cerveja Heineken 600ml', 'CERVEJAS', 'PRODUTO');
  assert.strictEqual(heineken.isBebida, true);
  assert.strictEqual(heineken.subtipo, 'BEBIDA');
  assert.strictEqual(heineken.categoriaBebida, 'CERVEJA');

  const agua = classificarItemCatalogo('Agua Mineral com Gas 500ml', 'REFRIGERANTES', 'PRODUTO');
  assert.strictEqual(agua.isBebida, true);
  assert.strictEqual(agua.categoriaBebida, 'AGUA');

  const pepsiComp = classificarItemCatalogo('pepsi lata zero', 'escolha o refrigerante', 'COMPLEMENTO');
  assert.strictEqual(pepsiComp.isBebida, true);
  assert.strictEqual(pepsiComp.subtipo, 'BEBIDA');

  // 2. Deve EXCLUIR explicitamente drinks e sucos (solicitação do usuário)
  const caipirinha = classificarItemCatalogo('Caipirinha Tradicional', 'DRINKS DA CASA', 'PRODUTO');
  assert.strictEqual(caipirinha.isBebida, false);

  const gin = classificarItemCatalogo('Gin basil smash', 'DRINKS DA CASA', 'PRODUTO');
  assert.strictEqual(gin.isBebida, false);

  const limonada = classificarItemCatalogo('Limonada', 'SUCOS', 'PRODUTO');
  assert.strictEqual(limonada.isBebida, false);

  const sucoLaranja = classificarItemCatalogo('Suco de Laranja 500 Ml', 'SUCOS', 'PRODUTO');
  assert.strictEqual(sucoLaranja.isBebida, false);

  const sucoComp = classificarItemCatalogo('Suco de Laranja 200ml', 'Complementos iFood', 'COMPLEMENTO');
  assert.strictEqual(sucoComp.isBebida, false);

  // 3. Deve EXCLUIR modificadores de lanches (anti-falso positivo)
  const retirarTomate = classificarItemCatalogo('RETIRAR tomate', 'retirar ingredientes', 'COMPLEMENTO');
  assert.strictEqual(retirarTomate.isBebida, false);

  // 4. Deve identificar combos com refrigerante
  const comboSmash = classificarItemCatalogo('American Smash + Refri de 200ml', 'BURGER', 'PRODUTO');
  assert.strictEqual(comboSmash.isBebida, true);
  assert.strictEqual(comboSmash.subtipo, 'COMBO_COM_BEBIDA');
});

test('Busca Global: filtros por termo, tipo e apenas bebidas', () => {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);

  // Cadastra produtos de teste
  upsertProduto(db, {
    id: 1,
    nome: 'Coca-Cola Lata 350ml',
    categoria_nome: 'REFRIGERANTES',
    preco: 6.5,
    ativo: 1,
    updated_at: ''
  });

  upsertProduto(db, {
    id: 2,
    nome: 'Cerveja Corona Long Neck 330ml',
    categoria_nome: 'CERVEJAS',
    preco: 12.0,
    ativo: 1,
    updated_at: ''
  });

  upsertProduto(db, {
    id: 3,
    nome: 'Suco de Morango Natural',
    categoria_nome: 'SUCOS',
    preco: 14.0,
    ativo: 1,
    updated_at: ''
  });

  upsertProduto(db, {
    id: 4,
    nome: 'Classic Cheeseburger Duplo',
    categoria_nome: 'BURGERS',
    preco: 32.0,
    ativo: 1,
    updated_at: ''
  });

  // Cadastra complementos de teste
  upsertComplemento(db, {
    id: 101,
    nome: 'pepsi lata zero',
    categoria_nome: 'escolha o refrigerante',
    preco: 0,
    ativo: 1,
    updated_at: ''
  });

  upsertComplemento(db, {
    id: 102,
    nome: 'Bacon Extra Fatiado',
    categoria_nome: 'Adicionais',
    preco: 5.0,
    ativo: 1,
    updated_at: ''
  });

  // 1. Busca padrão apenas bebidas (deve retornar Coca, Corona e Pepsi, mas NÃO Suco, Burguer ou Bacon)
  const bebidas = buscaGlobalCatalogo(db, { apenasBebidas: true });
  assert.strictEqual(bebidas.length, 3);
  const nomes = bebidas.map(b => b.nome);
  assert.ok(nomes.includes('Coca-Cola Lata 350ml'));
  assert.ok(nomes.includes('Cerveja Corona Long Neck 330ml'));
  assert.ok(nomes.includes('pepsi lata zero'));
  assert.ok(!nomes.includes('Suco de Morango Natural')); // Suco excluído
  assert.ok(!nomes.includes('Classic Cheeseburger Duplo'));

  // 2. Busca por termo 'pepsi'
  const buscaPepsi = buscaGlobalCatalogo(db, { termo: 'pepsi' });
  assert.strictEqual(buscaPepsi.length, 1);
  assert.strictEqual(buscaPepsi[0].nome, 'pepsi lata zero');
  assert.strictEqual(buscaPepsi[0].tipo, 'COMPLEMENTO');

  // 3. Busca em todo o catálogo (apenasBebidas: false)
  const todoCatalogo = buscaGlobalCatalogo(db, { apenasBebidas: false });
  assert.strictEqual(todoCatalogo.length, 6);
});
