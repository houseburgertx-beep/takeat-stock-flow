import type { DatabaseSync } from 'node:sqlite';
import {
  isOrderProcessed,
  savePedidoProcessado,
  getFichaTecnicaProduto,
  getFichaTecnicaComplemento,
  getInsumoById,
  movimentarEstoque,
  getAlertasEstoque,
  addSyncLog,
  getInsumoByCodigo,
} from '../db/database.ts';
import type {
  TakeatTableSession,
  AlertaEstoque,
  UnidadeMedida,
} from '../types/index.ts';

export interface ConsumoInsumoResumo {
  insumo_id: number;
  insumo_nome: string;
  quantidade_consumida: number;
  unidade: UnidadeMedida;
  saldo_restante: number;
}

export interface DeductionProcessResult {
  sessoesAnalisadas: number;
  pedidosProcessados: number;
  pedidosPulados: number; // Já processados ou cancelados
  itensConsumidos: ConsumoInsumoResumo[];
  alertasEstoque: AlertaEstoque[];
}

export class DeductionService {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Converte unidades quando a receita está em uma escala e o estoque em outra
   * Ex: Estoque em kg e receita em g (1 kg = 1000 g)
   *     Estoque em l e receita em ml (1 l = 1000 ml)
   */
  public converterUnidade(
    quantidadeNaReceita: number,
    unidadeReceita: UnidadeMedida,
    unidadeEstoque: UnidadeMedida
  ): number {
    if (unidadeReceita === unidadeEstoque) {
      return quantidadeNaReceita;
    }

    // Peso: g <-> kg
    if (unidadeReceita === 'g' && unidadeEstoque === 'kg') {
      return quantidadeNaReceita / 1000;
    }
    if (unidadeReceita === 'kg' && unidadeEstoque === 'g') {
      return quantidadeNaReceita * 1000;
    }

    // Volume: ml <-> l
    if (unidadeReceita === 'ml' && unidadeEstoque === 'l') {
      return quantidadeNaReceita / 1000;
    }
    if (unidadeReceita === 'l' && unidadeEstoque === 'ml') {
      return quantidadeNaReceita * 1000;
    }

    // Se as unidades não forem diretamente convertíveis (ex: un com g), mantém o valor nominal
    return quantidadeNaReceita;
  }

  /**
   * Processa sessões de comandas da Takeat, baixando insumos de produtos e complementos
   */
  public processarSessoes(sessions: TakeatTableSession[]): DeductionProcessResult {
    let sessoesAnalisadas = 0;
    let pedidosProcessadosCount = 0;
    let pedidosPuladosCount = 0;
    const mapaConsumo = new Map<number, { nome: string; quantidade: number; unidade: UnidadeMedida }>();

    for (const session of sessions) {
      sessoesAnalisadas++;

      // Ignora sessões canceladas ou ainda sem fechamento se aplicável
      if (session.status === 'canceled') {
        continue;
      }

      if (!session.bills || !Array.isArray(session.bills)) {
        continue;
      }

      for (const bill of session.bills) {
        if (!bill.order_baskets || !Array.isArray(bill.order_baskets)) {
          continue;
        }

        for (const basket of bill.order_baskets) {
          if (!basket.orders || !Array.isArray(basket.orders)) {
            continue;
          }

          for (const order of basket.orders) {
            // Verifica cancelamento do pedido individual
            if (order.canceled_at || order.order_status === 'canceled') {
              pedidosPuladosCount++;
              continue;
            }

            // Garante Idempotência: não processa o mesmo order_id mais de uma vez
            if (isOrderProcessed(this.db, order.id)) {
              pedidosPuladosCount++;
              continue;
            }

            const productId = order.product.id;
            const productName = order.product.name;
            const orderAmount = order.amount || 1;
            const orderTotal = parseFloat(order.total_price || order.price || '0');
            const dataPedido = session.completed_at || session.end_time || new Date().toISOString();

            // Lista de complementos vinculados a este pedido
            const complementosExtraidos: { complemento_id: number; complemento_nome: string; quantidade: number }[] = [];

            if (order.complement_categories && Array.isArray(order.complement_categories)) {
              for (const cat of order.complement_categories) {
                if (cat.order_complements && Array.isArray(cat.order_complements)) {
                  for (const comp of cat.order_complements) {
                    complementosExtraidos.push({
                      complemento_id: comp.complement.id,
                      complemento_nome: comp.complement.name,
                      quantidade: comp.amount || 1,
                    });
                  }
                }
              }
            }

            // 1. Processa Dedução dos Insumos da Ficha Técnica do PRODUTO
            const fichaProduto = getFichaTecnicaProduto(this.db, productId);

            if (fichaProduto.length > 0) {
              for (const item of fichaProduto) {
                const insumo = getInsumoById(this.db, item.insumo_id);
                if (!insumo) continue;

                const qtdConvertida = this.converterUnidade(
                  item.quantidade_consumida,
                  item.unidade_consumida as UnidadeMedida,
                  insumo.unidade
                );

                const consumoTotal = Number((orderAmount * qtdConvertida).toFixed(4));

                movimentarEstoque(
                  this.db,
                  insumo.id,
                  -consumoTotal,
                  'SAIDA_VENDA',
                  'PEDIDO',
                  String(order.id),
                  `Venda: ${orderAmount}x ${productName} (Item: ${insumo.nome})`
                );

                const atual = mapaConsumo.get(insumo.id) || {
                  nome: insumo.nome,
                  quantidade: 0,
                  unidade: insumo.unidade,
                };
                atual.quantidade += consumoTotal;
                mapaConsumo.set(insumo.id, atual);
              }
            } else {
              // Se o produto não tiver ficha cadastrada, verifica se existe insumo direto 1:1 (ex.: Bebida pronta em lata)
              const codigoProvavel = `TK-${productName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
              const insumoDireto = getInsumoByCodigo(this.db, codigoProvavel);

              if (insumoDireto && insumoDireto.unidade === 'un') {
                movimentarEstoque(
                  this.db,
                  insumoDireto.id,
                  -orderAmount,
                  'SAIDA_VENDA',
                  'PEDIDO',
                  String(order.id),
                  `Venda direta: ${orderAmount}x ${productName}`
                );

                const atual = mapaConsumo.get(insumoDireto.id) || {
                  nome: insumoDireto.nome,
                  quantidade: 0,
                  unidade: insumoDireto.unidade,
                };
                atual.quantidade += orderAmount;
                mapaConsumo.set(insumoDireto.id, atual);
              }
            }

            // 2. Processa Dedução dos Insumos da Ficha Técnica dos COMPLEMENTOS
            for (const comp of complementosExtraidos) {
              const fichaComp = getFichaTecnicaComplemento(this.db, comp.complemento_id);
              if (fichaComp.length > 0) {
                for (const item of fichaComp) {
                  const insumo = getInsumoById(this.db, item.insumo_id);
                  if (!insumo) continue;

                  const qtdConvertida = this.converterUnidade(
                    item.quantidade_consumida,
                    item.unidade_consumida as UnidadeMedida,
                    insumo.unidade
                  );

                  const consumoTotal = Number((comp.quantidade * qtdConvertida).toFixed(4));

                  movimentarEstoque(
                    this.db,
                    insumo.id,
                    -consumoTotal,
                    'SAIDA_VENDA',
                    'PEDIDO',
                    String(order.id),
                    `Adicional: ${comp.quantidade}x ${comp.complemento_nome} (Item: ${insumo.nome})`
                  );

                  const atual = mapaConsumo.get(insumo.id) || {
                    nome: insumo.nome,
                    quantidade: 0,
                    unidade: insumo.unidade,
                  };
                  atual.quantidade += consumoTotal;
                  mapaConsumo.set(insumo.id, atual);
                }
              }
            }

            // 3. Registra o pedido como processado
            savePedidoProcessado(
              this.db,
              {
                order_id: order.id,
                session_id: session.id,
                basket_id: basket.basket_id || null,
                produto_id: productId,
                produto_nome: productName,
                quantidade: orderAmount,
                preco_total: orderTotal,
                canal: basket.channel || 'salao',
                comanda_numero: session.table?.table_type === 'command' ? String(session.table.table_number) : null,
                mesa_numero: session.table?.table_type === 'table' ? String(session.table.table_number) : null,
                data_pedido: dataPedido,
                data_processamento: new Date().toISOString(),
              },
              complementosExtraidos
            );

            pedidosProcessadosCount++;
          }
        }
      }
    }

    // Monta o resumo dos itens consumidos
    const itensConsumidos: ConsumoInsumoResumo[] = [];
    for (const [insumoId, data] of mapaConsumo.entries()) {
      const insumo = getInsumoById(this.db, insumoId);
      itensConsumidos.push({
        insumo_id: insumoId,
        insumo_nome: data.nome,
        quantidade_consumida: Number(data.quantidade.toFixed(4)),
        unidade: data.unidade,
        saldo_restante: insumo ? insumo.quantidade : 0,
      });
    }

    const alertasEstoque = getAlertasEstoque(this.db);

    if (pedidosProcessadosCount > 0) {
      addSyncLog(
        this.db,
        'VENDAS',
        'SUCCESS',
        `Processados ${pedidosProcessadosCount} pedidos Takeat com baixa automática de estoque.`
      );
    }

    return {
      sessoesAnalisadas,
      pedidosProcessados: pedidosProcessadosCount,
      pedidosPulados: pedidosPuladosCount,
      itensConsumidos,
      alertasEstoque,
    };
  }
}
