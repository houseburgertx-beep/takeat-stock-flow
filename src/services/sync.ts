import type { DatabaseSync } from 'node:sqlite';
import { TakeatClient } from '../takeat/client.ts';
import {
  createInsumo,
  getInsumoByCodigo,
  updateInsumo,
  upsertProduto,
  upsertComplemento,
  addSyncLog,
  getAllInsumos,
} from '../db/database.ts';
import type { CategoriaInsumo, UnidadeMedida } from '../types/index.ts';

export class SyncService {
  private db: DatabaseSync;
  private client: TakeatClient;

  constructor(db: DatabaseSync, client: TakeatClient) {
    this.db = db;
    this.client = client;
  }

  /**
   * Sincroniza insumos da Takeat (/v1/inputs) com a base local
   */
  async syncInsumos(): Promise<{ criados: number; atualizados: number; total: number }> {
    try {
      const takeatInputs = await this.client.getAllInputs();
      let criados = 0;
      let atualizados = 0;

      for (const item of takeatInputs) {
        // Gera um código determinístico baseado no nome caso não venha ID
        const codigo = `TK-${item.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
        const existing = getInsumoByCodigo(this.db, codigo);

        // Identifica categoria provável
        let categoria: CategoriaInsumo = 'insumo';
        const lowerName = item.name.toLowerCase();
        if (
          lowerName.includes('coca') ||
          lowerName.includes('cerveja') ||
          lowerName.includes('suco') ||
          lowerName.includes('água') ||
          lowerName.includes('agua') ||
          lowerName.includes('chopp') ||
          lowerName.includes('refrigerante') ||
          lowerName.includes('gin') ||
          lowerName.includes('vodka') ||
          lowerName.includes('rum') ||
          lowerName.includes('whisky') ||
          lowerName.includes('vinho') ||
          lowerName.includes('energético')
        ) {
          categoria = 'bebida';
        } else if (
          lowerName.includes('embalagem') ||
          lowerName.includes('sacola') ||
          lowerName.includes('copo') ||
          lowerName.includes('canudo') ||
          lowerName.includes('guardanapo')
        ) {
          categoria = 'embalagem';
        }

        const unidadeNormalizada: UnidadeMedida = this.normalizarUnidade(item.unidade);
        const quantidade = parseFloat(item.quantidade || '0') || 0;
        const estoqueMin = parseFloat(item.minimum_stock || '0') || 0;
        const estoqueIdeal = parseFloat(item.ideal_stock || '0') || 0;
        const precoUnit = parseFloat(item.unitary_price || '0') || 0;

        if (existing) {
          updateInsumo(this.db, existing.id, {
            nome: item.name,
            categoria,
            unidade: unidadeNormalizada,
            estoque_minimo: estoqueMin,
            estoque_ideal: estoqueIdeal,
            preco_unitario: precoUnit,
            is_master: item.is_master ? 1 : 0,
          });
          atualizados++;
        } else {
          createInsumo(this.db, {
            codigo,
            nome: item.name,
            categoria,
            unidade: unidadeNormalizada,
            quantidade,
            estoque_minimo: estoqueMin,
            estoque_ideal: estoqueIdeal,
            preco_unitario: precoUnit,
            is_master: item.is_master ? 1 : 0,
          });
          criados++;
        }
      }

      addSyncLog(this.db, 'INSUMOS', 'SUCCESS', `Sincronizados ${takeatInputs.length} insumos (${criados} novos, ${atualizados} atualizados)`);
      return { criados, atualizados, total: takeatInputs.length };
    } catch (err: any) {
      addSyncLog(this.db, 'INSUMOS', 'ERROR', err.message);
      throw err;
    }
  }

  /**
   * Sincroniza catálogo de produtos e complementos da Takeat (/v1/products e /v1/complements)
   */
  async syncCatalogo(): Promise<{ produtos: number; complementos: number }> {
    try {
      let produtosCount = 0;
      let complementosCount = 0;

      // 1. Produtos
      const categories = await this.client.getProducts();
      if (Array.isArray(categories)) {
        for (const cat of categories) {
          const catName = cat.name || 'Geral';
          if (Array.isArray(cat.products)) {
            for (const prod of cat.products) {
              upsertProduto(this.db, {
                id: prod.id,
                nome: prod.name,
                categoria_nome: catName,
                preco: parseFloat(prod.price || '0') || 0,
                ativo: prod.available !== false ? 1 : 0,
                updated_at: new Date().toISOString(),
              });
              produtosCount++;
            }
          }
        }
      }

      // 2. Complementos
      const compCategories = await this.client.getComplements();
      if (Array.isArray(compCategories)) {
        for (const cat of compCategories) {
          const catName = cat.name || 'Complementos';
          if (Array.isArray(cat.complements)) {
            for (const comp of cat.complements) {
              upsertComplemento(this.db, {
                id: comp.id,
                nome: comp.name,
                categoria_nome: catName,
                preco: parseFloat(comp.price || '0') || 0,
                ativo: comp.available !== false ? 1 : 0,
                updated_at: new Date().toISOString(),
              });
              complementosCount++;
            }
          }
        }
      }

      addSyncLog(
        this.db,
        'CATALOGO',
        'SUCCESS',
        `Sincronizados ${produtosCount} produtos e ${complementosCount} complementos`
      );
      return { produtos: produtosCount, complementos: complementosCount };
    } catch (err: any) {
      addSyncLog(this.db, 'CATALOGO', 'ERROR', err.message);
      throw err;
    }
  }

  private normalizarUnidade(rawUnit?: string): UnidadeMedida {
    if (!rawUnit) return 'un';
    const clean = rawUnit.toLowerCase().trim();
    if (['kg', 'quilo', 'quilos'].includes(clean)) return 'kg';
    if (['g', 'grama', 'gramas'].includes(clean)) return 'g';
    if (['l', 'litro', 'litros'].includes(clean)) return 'l';
    if (['ml', 'mililitro', 'mililitros'].includes(clean)) return 'ml';
    return 'un';
  }
}
