export type CategoriaInsumo = 'bebida' | 'insumo' | 'alimento' | 'embalagem';
export type UnidadeMedida = 'un' | 'ml' | 'l' | 'g' | 'kg';

export interface Insumo {
  id: number;
  codigo: string;
  nome: string;
  categoria: CategoriaInsumo;
  unidade: UnidadeMedida;
  quantidade: number;
  estoque_minimo: number;
  estoque_ideal: number;
  preco_unitario: number;
  is_master: number; // 0 ou 1
  created_at: string;
  updated_at: string;
}

export interface Produto {
  id: number; // ID do produto na Takeat
  nome: string;
  categoria_nome: string;
  preco: number;
  ativo: number; // 0 ou 1
  tem_ficha?: boolean;
  updated_at: string;
}

export interface Complemento {
  id: number; // ID do complemento na Takeat
  nome: string;
  categoria_nome: string;
  preco: number;
  ativo: number; // 0 ou 1
  tem_ficha?: boolean;
  updated_at: string;
}

export interface FichaTecnicaProdutoItem {
  id?: number;
  produto_id: number;
  insumo_id: number;
  insumo_nome?: string;
  insumo_unidade?: UnidadeMedida;
  insumo_estoque?: number;
  quantidade_consumida: number;
  unidade_consumida: UnidadeMedida;
  created_at?: string;
}

export interface FichaTecnicaComplementoItem {
  id?: number;
  complemento_id: number;
  insumo_id: number;
  insumo_nome?: string;
  insumo_unidade?: UnidadeMedida;
  insumo_estoque?: number;
  quantidade_consumida: number;
  unidade_consumida: UnidadeMedida;
  created_at?: string;
}

export type TipoMovimentacao = 'SAIDA_VENDA' | 'ENTRADA_COMPRA' | 'AJUSTE_INVENTARIO' | 'PERDA';

export interface MovimentacaoEstoque {
  id?: number;
  insumo_id: number;
  insumo_nome?: string;
  insumo_unidade?: string;
  tipo: TipoMovimentacao;
  quantidade: number;
  saldo_anterior: number;
  saldo_posterior: number;
  referencia_tipo: 'PEDIDO' | 'MANUAL' | 'SYNC';
  referencia_id: string;
  descricao: string;
  data_hora: string;
}

export interface PedidoProcessado {
  id?: number;
  order_id: number;
  session_id: number;
  basket_id: string | null;
  produto_id: number;
  produto_nome: string;
  quantidade: number;
  preco_total: number;
  canal: string | null;
  comanda_numero: string | null;
  mesa_numero: string | null;
  data_pedido: string;
  data_processamento: string;
}

export interface PedidoComplementoProcessado {
  id?: number;
  pedido_processado_id: number;
  complemento_id: number;
  complemento_nome: string;
  quantidade: number;
}

export interface AlertaEstoque {
  insumo_id: number;
  insumo_nome: string;
  categoria: CategoriaInsumo;
  unidade: UnidadeMedida;
  saldo_atual: number;
  estoque_minimo: number;
  deficit: number;
  nivel_alerta: 'CRITICO' | 'ALERTA';
}

export interface TakeatTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

// Modelos simplificados da Takeat API V1.0
export interface TakeatInputItem {
  name: string;
  unidade: string;
  quantidade: string | null;
  total_value: string | null;
  unitary_price: string | null;
  ideal_stock: string | null;
  minimum_stock: string | null;
  is_master: boolean | null;
  cash_flow_category_subcategory?: string;
}

export interface TakeatOrderComplement {
  id: number;
  amount: number;
  complement: {
    id: number;
    name: string;
  };
}

export interface TakeatComplementCategory {
  id: number;
  complement_category: {
    id: number;
    name: string;
  };
  order_complements: TakeatOrderComplement[];
}

export interface TakeatOrder {
  id: number;
  amount: number;
  price: string;
  total_price: string;
  order_status?: string;
  canceled_at?: string | null;
  product: {
    id: number;
    name: string;
  };
  complement_categories?: TakeatComplementCategory[];
}

export interface TakeatOrderBasket {
  id: number;
  basket_id: string;
  channel?: string;
  orders: TakeatOrder[];
}

export interface TakeatBill {
  id: number;
  order_baskets: TakeatOrderBasket[];
}

export interface TakeatTableSession {
  id: number;
  status: string;
  completed_at?: string | null;
  end_time?: string | null;
  table?: {
    table_number: number;
    table_type: string;
  };
  bills: TakeatBill[];
}
