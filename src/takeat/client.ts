import type { DatabaseSync } from 'node:sqlite';
import { getTokenCache, saveTokenCache } from '../db/database.ts';
import type {
  TakeatTokenResponse,
  TakeatInputItem,
  TakeatTableSession,
} from '../types/index.ts';

export interface TakeatClientConfig {
  apiKey?: string;
  baseUrl?: string;
  restaurantId?: string | number;
  db?: DatabaseSync;
}

export class TakeatClient {
  private apiKey: string;
  private baseUrl: string;
  private restaurantId?: string | number;
  private db?: DatabaseSync;

  // Controle de renovação concorrente (uma única promessa em andamento)
  private refreshPromise: Promise<string> | null = null;

  constructor(config: TakeatClientConfig = {}) {
    this.apiKey = config.apiKey || process.env.TAKEAT_API_KEY || '';
    this.baseUrl = (config.baseUrl || process.env.TAKEAT_API_URL || 'https://public-api.takeat.app').replace(/\/+$/, '');
    this.restaurantId = config.restaurantId || process.env.TAKEAT_RESTAURANT_ID;
    this.db = config.db;
  }

  /**
   * Obtém um access_token válido, reaproveitando o cache ou renovando automaticamente
   */
  async getValidAccessToken(): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        'TAKEAT_API_KEY não configurada. Defina a variável de ambiente ou informe no arquivo .env (consulte .env.example).'
      );
    }

    // 1. Tenta carregar do cache do banco
    if (this.db) {
      const cached = getTokenCache(this.db);
      if (cached) {
        const now = Date.now();
        // Margem de segurança de 60 segundos conforme documentação oficial
        const refreshAt = cached.expires_at - 60_000;

        if (now < refreshAt) {
          return cached.access_token;
        }

        // Se expirou ou está na janela de 60s, renova com o refresh_token
        return this.coordinateTokenRefresh(cached.refresh_token);
      }
    }

    // 2. Se não tem cache, emite novo par com a API key
    return this.exchangeApiKeyForTokens();
  }

  /**
   * Coordena a renovação para garantir que múltiplas chamadas simultâneas usem a mesma promessa
   */
  private async coordinateTokenRefresh(refreshToken: string): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const token = await this.refreshToken(refreshToken);
        return token;
      } catch (err: any) {
        // Se o refresh falhar por invalid_grant (expirado/revogado), tenta nova troca com a API key
        if (err.message && err.message.includes('invalid_grant')) {
          console.warn('[TakeatClient] Refresh token inválido ou expirado. Tentando nova troca com API key...');
          return await this.exchangeApiKeyForTokens();
        }
        throw err;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Troca inicial: POST /oauth/token com grant_type=api_key
   */
  async exchangeApiKeyForTokens(): Promise<string> {
    const startedAt = Date.now();
    const tokenUrl = `${this.baseUrl}/oauth/token`;

    const body = new URLSearchParams({
      grant_type: 'api_key',
      api_key: this.apiKey,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Falha ao emitir token Takeat (HTTP ${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as TakeatTokenResponse;
    const expiresAt = startedAt + (data.expires_in || 900) * 1000;

    if (this.db) {
      saveTokenCache(this.db, data.access_token, data.refresh_token, expiresAt, data.scope || '');
    }

    return data.access_token;
  }

  /**
   * Renovação: POST /oauth/token com grant_type=refresh_token
   */
  async refreshToken(refreshToken: string): Promise<string> {
    const startedAt = Date.now();
    const tokenUrl = `${this.baseUrl}/oauth/token`;

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Falha ao renovar token Takeat (HTTP ${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as TakeatTokenResponse;
    const expiresAt = startedAt + (data.expires_in || 900) * 1000;

    if (this.db) {
      saveTokenCache(this.db, data.access_token, data.refresh_token, expiresAt, data.scope || '');
    }

    return data.access_token;
  }

  /**
   * Executa requisição autenticada com Bearer Token e retry em caso de 401 ou 429
   */
  async request<T>(path: string, options: RequestInit = {}, retries = 2): Promise<T> {
    const token = await this.getValidAccessToken();
    const url = new URL(`${this.baseUrl}${path}`);

    if (this.restaurantId && !url.searchParams.has('restaurant_id')) {
      url.searchParams.set('restaurant_id', String(this.restaurantId));
    }

    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('Accept', 'application/json');

    const response = await fetch(url.toString(), {
      ...options,
      headers,
    });

    // 401: Token pode ter expirado ou sido revogado no backend
    if (response.status === 401 && retries > 0) {
      console.warn('[TakeatClient] Recebido 401. Renovando credenciais e repetindo chamada...');
      await this.exchangeApiKeyForTokens();
      return this.request<T>(path, options, retries - 1);
    }

    // 429: Rate limit excedido (10 req/min)
    if (response.status === 429 && retries > 0) {
      const retryAfterSec = Number(response.headers.get('Retry-After')) || 5;
      const waitMs = retryAfterSec * 1000 + Math.random() * 500;
      console.warn(`[TakeatClient] Rate limit 429 atingido. Aguardando ${waitMs}ms antes do retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return this.request<T>(path, options, retries - 1);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Erro Takeat API [${response.status} ${response.statusText}] em ${path}: ${text}`);
    }

    return (await response.json()) as T;
  }

  // ==========================================
  // ENDPOINTS DE DADOS V1.0
  // ==========================================

  /**
   * Consulta todos os insumos cadastrados na Takeat com paginação automática (100 por página)
   * GET /v1/inputs
   */
  async getAllInputs(): Promise<TakeatInputItem[]> {
    const allInputs: TakeatInputItem[] = [];
    let offset = 0;
    let remaining = 1;

    while (remaining > 0) {
      const res = await this.request<{
        total: number;
        count: number;
        remaining: number;
        limit: number;
        offset: number;
        inputs: TakeatInputItem[];
      }>(`/v1/inputs?offset=${offset}`);

      if (Array.isArray(res.inputs)) {
        allInputs.push(...res.inputs);
      }

      remaining = res.remaining;
      offset += res.count || 100;

      // Proteção de segurança contra loop infinito
      if (res.count === 0 && remaining > 0) break;
    }

    return allInputs;
  }

  /**
   * Consulta categorias e produtos
   * GET /v1/products
   */
  async getProducts(): Promise<any[]> {
    return this.request<any[]>('/v1/products');
  }

  /**
   * Consulta complementos por categoria
   * GET /v1/complements
   */
  async getComplements(): Promise<any[]> {
    return this.request<any[]>('/v1/complements');
  }

  /**
   * Consulta comandas e sessões de vendas (intervalo máximo permitido: 3 dias)
   * GET /v1/table-sessions?start_date=...&end_date=...
   */
  async getTableSessions(startDateUtc: string, endDateUtc: string): Promise<TakeatTableSession[]> {
    const query = new URLSearchParams({
      start_date: startDateUtc,
      end_date: endDateUtc,
    });
    return this.request<TakeatTableSession[]>(`/v1/table-sessions?${query.toString()}`);
  }
}
