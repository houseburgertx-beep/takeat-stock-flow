import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/db/schema.ts';
import {
  createInsumo,
  getInsumoById,
  upsertProduto,
  upsertComplemento,
  saveFichaTecnicaProduto,
  saveFichaTecnicaComplemento,
  getAlertasEstoque,
  getMovimentacoes,
  getPedidosProcessados,
} from '../src/db/database.ts';
import { DeductionService } from '../src/services/deduction.ts';
import type { TakeatTableSession } from '../src/types/index.ts';

test('DeductionService: Baixa de insumos por produto e complementos com conversão de unidades', () => {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  const service = new DeductionService(db);

  // 1. Cadastra Insumos
  // Cachaça em Litros (1L = 1000ml)
  const cachaca = createInsumo(db, {
    nome: 'Cachaça',
    categoria: 'bebida',
    unidade: 'l',
    quantidade: 2.0, // 2 litros
    estoque_minimo: 0.5,
  });

  // Limão em Unidades
  const limao = createInsumo(db, {
    nome: 'Limão',
    categoria: 'alimento',
    unidade: 'un',
    quantidade: 20,
    estoque_minimo: 5,
  });

  // Bacon em Quilogramas (1kg = 1000g)
  const bacon = createInsumo(db, {
    nome: 'Bacon',
    categoria: 'alimento',
    unidade: 'kg',
    quantidade: 1.0, // 1 kg
    estoque_minimo: 0.2,
  });

  // 2. Cadastra Produto (Caipirinha id: 10)
  upsertProduto(db, {
    id: 10,
    nome: 'Caipirinha Tradicional',
    categoria_nome: 'Drinks',
    preco: 20.0,
    ativo: 1,
    updated_at: '',
  });

  // Receita da Caipirinha: 50 ml de Cachaça (0.05 L) + 1 un de Limão
  saveFichaTecnicaProduto(db, 10, [
    { insumo_id: cachaca.id, quantidade_consumida: 50, unidade_consumida: 'ml' },
    { insumo_id: limao.id, quantidade_consumida: 1, unidade_consumida: 'un' },
  ]);

  // 3. Cadastra Complemento (Bacon Extra id: 50)
  upsertComplemento(db, {
    id: 50,
    nome: 'Bacon Extra 50g',
    categoria_nome: 'Adicionais',
    preco: 5.0,
    ativo: 1,
    updated_at: '',
  });

  // Receita do Complemento: 50 gramas de Bacon
  saveFichaTecnicaComplemento(db, 50, [
    { insumo_id: bacon.id, quantidade_consumida: 50, unidade_consumida: 'g' },
  ]);

  // 4. Mock de Sessão com Venda de 2 Caipirinhas com 1 Bacon Extra
  const mockSession: TakeatTableSession = {
    id: 1001,
    status: 'completed',
    completed_at: new Date().toISOString(),
    bills: [
      {
        id: 2001,
        order_baskets: [
          {
            id: 3001,
            basket_id: 'BSK-1',
            orders: [
              {
                id: 4001,
                amount: 2, // 2 Caipirinhas
                price: '20.00',
                total_price: '45.00',
                product: { id: 10, name: 'Caipirinha Tradicional' },
                complement_categories: [
                  {
                    id: 601,
                    complement_category: { id: 701, name: 'Adicionais' },
                    order_complements: [
                      { id: 801, amount: 1, complement: { id: 50, name: 'Bacon Extra 50g' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  // Processa a sessão
  const result = service.processarSessoes([mockSession]);

  assert.strictEqual(result.pedidosProcessados, 1);
  assert.strictEqual(result.pedidosPulados, 0);

  // Verificação dos saldos pós-dedução:
  // Cachaça: 2.0 L - (2 * 50ml = 100ml = 0.1L) = 1.9 L
  const cachacaAtual = getInsumoById(db, cachaca.id);
  assert.strictEqual(cachacaAtual?.quantidade, 1.9);

  // Limão: 20 un - (2 * 1 un = 2 un) = 18 un
  const limaoAtual = getInsumoById(db, limao.id);
  assert.strictEqual(limaoAtual?.quantidade, 18);

  // Bacon: 1.0 kg - (1 * 50g = 0.05kg) = 0.95 kg
  const baconAtual = getInsumoById(db, bacon.id);
  assert.strictEqual(baconAtual?.quantidade, 0.95);

  // Verifica se as movimentações foram gravadas no Ledger
  const ledger = getMovimentacoes(db);
  assert.strictEqual(ledger.length, 6); // 3 cadastros iniciais + 3 saídas por venda

  // 5. TESTE DE IDEMPOTÊNCIA: Se a mesma sessão for enviada novamente, NÃO PODE dar baixa dupla!
  const secondRun = service.processarSessoes([mockSession]);
  assert.strictEqual(secondRun.pedidosProcessados, 0);
  assert.strictEqual(secondRun.pedidosPulados, 1);

  // Os saldos devem permanecer rigorosamente idênticos
  assert.strictEqual(getInsumoById(db, cachaca.id)?.quantidade, 1.9);
  assert.strictEqual(getInsumoById(db, limao.id)?.quantidade, 18);
  assert.strictEqual(getInsumoById(db, bacon.id)?.quantidade, 0.95);
});

test('DeductionService: Pedidos cancelados não baixam estoque', () => {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  const service = new DeductionService(db);

  const cerveja = createInsumo(db, {
    nome: 'Cerveja Lata',
    categoria: 'bebida',
    unidade: 'un',
    quantidade: 10,
    estoque_minimo: 2,
  });

  upsertProduto(db, { id: 99, nome: 'Cerveja Lata', categoria_nome: 'Bebidas', preco: 10, ativo: 1, updated_at: '' });
  saveFichaTecnicaProduto(db, 99, [{ insumo_id: cerveja.id, quantidade_consumida: 1, unidade_consumida: 'un' }]);

  const sessionCancelada: TakeatTableSession = {
    id: 2002,
    status: 'completed',
    bills: [
      {
        id: 3002,
        order_baskets: [
          {
            id: 4002,
            orders: [
              {
                id: 5002,
                amount: 3,
                price: '10.00',
                total_price: '30.00',
                order_status: 'canceled',
                canceled_at: new Date().toISOString(),
                product: { id: 99, name: 'Cerveja Lata' },
              },
            ],
          },
        ],
      },
    ],
  };

  const result = service.processarSessoes([sessionCancelada]);
  assert.strictEqual(result.pedidosProcessados, 0);
  assert.strictEqual(result.pedidosPulados, 1);

  // Saldo permanece intacto
  assert.strictEqual(getInsumoById(db, cerveja.id)?.quantidade, 10);
});

test('DeductionService: Dispara alerta quando atinge o estoque mínimo', () => {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);
  const service = new DeductionService(db);

  const gin = createInsumo(db, {
    nome: 'Gin Importado',
    categoria: 'bebida',
    unidade: 'l',
    quantidade: 0.1, // apenas 100ml
    estoque_minimo: 0.5, // alerta se for <= 0.5L
  });

  upsertProduto(db, { id: 77, nome: 'Dose de Gin', categoria_nome: 'Doses', preco: 25, ativo: 1, updated_at: '' });
  saveFichaTecnicaProduto(db, 77, [{ insumo_id: gin.id, quantidade_consumida: 0.05, unidade_consumida: 'l' }]);

  const session: TakeatTableSession = {
    id: 3003,
    status: 'completed',
    bills: [
      {
        id: 4003,
        order_baskets: [
          {
            id: 5003,
            orders: [
              {
                id: 6003,
                amount: 1,
                price: '25.00',
                total_price: '25.00',
                product: { id: 77, name: 'Dose de Gin' },
              },
            ],
          },
        ],
      },
    ],
  };

  const res = service.processarSessoes([session]);
  assert.strictEqual(res.alertasEstoque.length, 1);
  assert.strictEqual(res.alertasEstoque[0].insumo_id, gin.id);
  assert.strictEqual(res.alertasEstoque[0].saldo_atual, 0.05);
});
