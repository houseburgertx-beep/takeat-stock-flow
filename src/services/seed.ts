import type { DatabaseSync } from 'node:sqlite';
import {
  createInsumo,
  upsertProduto,
  upsertComplemento,
  saveFichaTecnicaProduto,
  saveFichaTecnicaComplemento,
} from '../db/database.ts';
import { DeductionService } from './deduction.ts';
import type { TakeatTableSession } from '../types/index.ts';

export function seedDemoData(db: DatabaseSync): void {
  // 1. Cadastra Insumos e Bebidas realistas
  const insumoCerveja = createInsumo(db, {
    codigo: 'BEB-HEIN-330',
    nome: 'Cerveja Heineken Long Neck 330ml',
    categoria: 'bebida',
    unidade: 'un',
    quantidade: 48,
    estoque_minimo: 24,
    estoque_ideal: 72,
    preco_unitario: 5.8,
  });

  const insumoCoca = createInsumo(db, {
    codigo: 'BEB-COCA-350',
    nome: 'Coca-Cola Lata 350ml',
    categoria: 'bebida',
    unidade: 'un',
    quantidade: 60,
    estoque_minimo: 30,
    estoque_ideal: 90,
    preco_unitario: 3.2,
  });

  const insumoCachaca = createInsumo(db, {
    codigo: 'BEB-CACHACA-1L',
    nome: 'Cachaça Artesanal 1L',
    categoria: 'bebida',
    unidade: 'l',
    quantidade: 5.0,
    estoque_minimo: 2.0,
    estoque_ideal: 10.0,
    preco_unitario: 28.0,
  });

  const insumoVodka = createInsumo(db, {
    codigo: 'BEB-VODKA-1L',
    nome: 'Vodka Smirnoff 1L',
    categoria: 'bebida',
    unidade: 'l',
    quantidade: 4.5,
    estoque_minimo: 2.0,
    estoque_ideal: 8.0,
    preco_unitario: 42.0,
  });

  const insumoGin = createInsumo(db, {
    codigo: 'BEB-GIN-750ML',
    nome: 'Gin Tanqueray 750ml',
    categoria: 'bebida',
    unidade: 'l',
    quantidade: 3.0,
    estoque_minimo: 1.5,
    estoque_ideal: 6.0,
    preco_unitario: 95.0,
  });

  const insumoLimao = createInsumo(db, {
    codigo: 'ALI-LIMAO-UN',
    nome: 'Limão Taiti Fresco',
    categoria: 'alimento',
    unidade: 'un',
    quantidade: 80,
    estoque_minimo: 30,
    estoque_ideal: 120,
    preco_unitario: 0.6,
  });

  const insumoAcucar = createInsumo(db, {
    codigo: 'INS-ACUCAR-KG',
    nome: 'Açúcar Refinado',
    categoria: 'insumo',
    unidade: 'kg',
    quantidade: 15.0,
    estoque_minimo: 5.0,
    estoque_ideal: 25.0,
    preco_unitario: 4.5,
  });

  const insumoPao = createInsumo(db, {
    codigo: 'INS-PAO-BRIOCHE',
    nome: 'Pão de Hambúrguer Brioche',
    categoria: 'insumo',
    unidade: 'un',
    quantidade: 40,
    estoque_minimo: 20,
    estoque_ideal: 80,
    preco_unitario: 2.1,
  });

  const insumoCarne = createInsumo(db, {
    codigo: 'ALI-BLEND-160G',
    nome: 'Hambúrguer Blend 160g',
    categoria: 'alimento',
    unidade: 'un',
    quantidade: 50,
    estoque_minimo: 25,
    estoque_ideal: 100,
    preco_unitario: 7.5,
  });

  const insumoBacon = createInsumo(db, {
    codigo: 'ALI-BACON-KG',
    nome: 'Bacon Fatiado Defumado',
    categoria: 'alimento',
    unidade: 'kg',
    quantidade: 6.0,
    estoque_minimo: 3.0,
    estoque_ideal: 12.0,
    preco_unitario: 38.0,
  });

  const insumoCheddar = createInsumo(db, {
    codigo: 'ALI-CHEDDAR-KG',
    nome: 'Queijo Cheddar Fatiado',
    categoria: 'alimento',
    unidade: 'kg',
    quantidade: 8.0,
    estoque_minimo: 4.0,
    estoque_ideal: 15.0,
    preco_unitario: 45.0,
  });

  // 2. Cadastra Produtos do Catálogo Takeat
  upsertProduto(db, { id: 101, nome: 'Caipirinha Tradicional', categoria_nome: 'Drinks', preco: 22.0, ativo: 1, updated_at: '' });
  upsertProduto(db, { id: 102, nome: 'Gin Tônica Clássica', categoria_nome: 'Drinks', preco: 28.0, ativo: 1, updated_at: '' });
  upsertProduto(db, { id: 103, nome: 'Heineken Long Neck', categoria_nome: 'Cervejas', preco: 14.0, ativo: 1, updated_at: '' });
  upsertProduto(db, { id: 104, nome: 'Coca-Cola Lata', categoria_nome: 'Refrigerantes', preco: 8.0, ativo: 1, updated_at: '' });
  upsertProduto(db, { id: 105, nome: 'Burguer Artesanal Duplo', categoria_nome: 'Hambúrgueres', preco: 38.0, ativo: 1, updated_at: '' });

  // 3. Cadastra Complementos / Adicionais do Takeat
  upsertComplemento(db, { id: 201, nome: 'Dose Extra de Vodka 50ml', categoria_nome: 'Doses Extras', preco: 10.0, ativo: 1, updated_at: '' });
  upsertComplemento(db, { id: 202, nome: 'Bacon Fatiado Extra 50g', categoria_nome: 'Adicionais Burguer', preco: 6.0, ativo: 1, updated_at: '' });
  upsertComplemento(db, { id: 203, nome: 'Queijo Cheddar Extra 30g', categoria_nome: 'Adicionais Burguer', preco: 5.0, ativo: 1, updated_at: '' });

  // 4. Cadastra Fichas Técnicas (Receituário)
  // Caipirinha: 60ml de Cachaça (0.06L) + 1 un Limão + 25g de Açúcar (0.025kg)
  saveFichaTecnicaProduto(db, 101, [
    { insumo_id: insumoCachaca.id, quantidade_consumida: 0.06, unidade_consumida: 'l' },
    { insumo_id: insumoLimao.id, quantidade_consumida: 1, unidade_consumida: 'un' },
    { insumo_id: insumoAcucar.id, quantidade_consumida: 0.025, unidade_consumida: 'kg' },
  ]);

  // Gin Tônica: 60ml de Gin (0.06L) + 0.5 un Limão
  saveFichaTecnicaProduto(db, 102, [
    { insumo_id: insumoGin.id, quantidade_consumida: 0.06, unidade_consumida: 'l' },
    { insumo_id: insumoLimao.id, quantidade_consumida: 0.5, unidade_consumida: 'un' },
  ]);

  // Heineken: 1 un Cerveja
  saveFichaTecnicaProduto(db, 103, [
    { insumo_id: insumoCerveja.id, quantidade_consumida: 1, unidade_consumida: 'un' },
  ]);

  // Coca-Cola: 1 un Lata
  saveFichaTecnicaProduto(db, 104, [
    { insumo_id: insumoCoca.id, quantidade_consumida: 1, unidade_consumida: 'un' },
  ]);

  // Burguer Duplo: 1 un Pão + 2 un Blend Carne + 40g Cheddar (0.04kg)
  saveFichaTecnicaProduto(db, 105, [
    { insumo_id: insumoPao.id, quantidade_consumida: 1, unidade_consumida: 'un' },
    { insumo_id: insumoCarne.id, quantidade_consumida: 2, unidade_consumida: 'un' },
    { insumo_id: insumoCheddar.id, quantidade_consumida: 0.04, unidade_consumida: 'kg' },
  ]);

  // Fichas de Complementos:
  // Dose extra Vodka: 50ml (0.05L)
  saveFichaTecnicaComplemento(db, 201, [
    { insumo_id: insumoVodka.id, quantidade_consumida: 0.05, unidade_consumida: 'l' },
  ]);

  // Bacon Extra: 50g (0.05kg)
  saveFichaTecnicaComplemento(db, 202, [
    { insumo_id: insumoBacon.id, quantidade_consumida: 0.05, unidade_consumida: 'kg' },
  ]);

  // Cheddar Extra: 30g (0.03kg)
  saveFichaTecnicaComplemento(db, 203, [
    { insumo_id: insumoCheddar.id, quantidade_consumida: 0.03, unidade_consumida: 'kg' },
  ]);

  // 5. Simula Vendas Realistas da Takeat e Executa Dedução Automática
  const deductionService = new DeductionService(db);
  const nowIso = new Date().toISOString();

  const mockSessions: TakeatTableSession[] = [
    {
      id: 9001,
      status: 'completed',
      completed_at: nowIso,
      table: { table_number: 12, table_type: 'table' },
      bills: [
        {
          id: 7001,
          order_baskets: [
            {
              id: 6001,
              basket_id: 'BSK-101',
              channel: 'salao',
              orders: [
                {
                  id: 5001,
                  amount: 2,
                  price: '22.00',
                  total_price: '44.00',
                  product: { id: 101, name: 'Caipirinha Tradicional' },
                },
                {
                  id: 5002,
                  amount: 1,
                  price: '38.00',
                  total_price: '49.00',
                  product: { id: 105, name: 'Burguer Artesanal Duplo' },
                  complement_categories: [
                    {
                      id: 301,
                      complement_category: { id: 401, name: 'Adicionais' },
                      order_complements: [
                        { id: 801, amount: 1, complement: { id: 202, name: 'Bacon Fatiado Extra 50g' } },
                        { id: 802, amount: 1, complement: { id: 203, name: 'Queijo Cheddar Extra 30g' } },
                      ],
                    },
                  ],
                },
                {
                  id: 5003,
                  amount: 3,
                  price: '14.00',
                  total_price: '42.00',
                  product: { id: 103, name: 'Heineken Long Neck' },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 9002,
      status: 'completed',
      completed_at: nowIso,
      table: { table_number: 4, table_type: 'table' },
      bills: [
        {
          id: 7002,
          order_baskets: [
            {
              id: 6002,
              basket_id: 'BSK-102',
              channel: 'delivery',
              orders: [
                {
                  id: 5004,
                  amount: 2,
                  price: '28.00',
                  total_price: '66.00',
                  product: { id: 102, name: 'Gin Tônica Clássica' },
                  complement_categories: [
                    {
                      id: 302,
                      complement_category: { id: 402, name: 'Doses' },
                      order_complements: [
                        { id: 803, amount: 1, complement: { id: 201, name: 'Dose Extra de Vodka 50ml' } },
                      ],
                    },
                  ],
                },
                {
                  id: 5005,
                  amount: 2,
                  price: '8.00',
                  total_price: '16.00',
                  product: { id: 104, name: 'Coca-Cola Lata' },
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  deductionService.processarSessoes(mockSessions);
}
