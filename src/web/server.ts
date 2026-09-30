import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import {
  getAllInsumos,
  getInsumoById,
  createInsumo,
  updateInsumo,
  movimentarEstoque,
  getAlertasEstoque,
  getAllProdutos,
  getAllComplementos,
  getFichaTecnicaProduto,
  saveFichaTecnicaProduto,
  getFichaTecnicaComplemento,
  saveFichaTecnicaComplemento,
  getPedidosProcessados,
  getMovimentacoes,
  getTokenCache,
  clearTokenCache,
  getRecentSyncLogs,
  getOrCreateContagemHoje,
  atualizarItemContagem,
  atualizarCabecalhoContagem,
  adicionarProdutoContagem,
  removerProdutoContagem,
  listarHistoricoContagens,
} from '../db/database.ts';
import { TakeatClient } from '../takeat/client.ts';
import { SyncService } from '../services/sync.ts';
import { DeductionService } from '../services/deduction.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createWebServer(db: DatabaseSync, client: TakeatClient) {
  const syncService = new SyncService(db, client);
  const deductionService = new DeductionService(db);

  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    const sendJson = (statusCode: number, data: any) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };

    const getBody = async (): Promise<any> => {
      return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (e) {
            reject(new Error('JSON inválido no corpo da requisição'));
          }
        });
        req.on('error', reject);
      });
    };

    try {
      // -------------------------------------------------------------
      // ROTAS DA API
      // -------------------------------------------------------------

      // 1. Status do Sistema e Conexão Takeat
      if (pathname === '/api/status' && req.method === 'GET') {
        const token = getTokenCache(db);
        const hasKey = Boolean(process.env.TAKEAT_API_KEY && process.env.TAKEAT_API_KEY !== 'tk_test_seu_token_aqui');
        const now = Date.now();
        const tokenValid = token ? token.expires_at > now : false;

        return sendJson(200, {
          online: true,
          takeat_api_key_configurada: hasKey,
          token_valido: tokenValid,
          token_expira_em_segundos: token ? Math.max(0, Math.floor((token.expires_at - now) / 1000)) : 0,
          escopos_token: token?.scope || null,
          recent_logs: getRecentSyncLogs(db, 5),
        });
      }

      // Configuração direta da chave via interface local
      if (pathname === '/api/config/key' && req.method === 'POST') {
        const body = await getBody();
        const rawKey = (body.apiKey || '').trim().replace(/^['"]|['"]$/g, '');

        if (!rawKey || rawKey.length < 5) {
          return sendJson(400, { error: 'Chave não informada ou inválida.' });
        }

        // Limpa cache de tokens antigos para forçar emissão limpa
        clearTokenCache(db);

        process.env.TAKEAT_API_KEY = rawKey;
        client.setApiKey(rawKey);

        // Atualiza o arquivo .env no disco local
        const envPath = join(process.cwd(), '.env');
        let envContent = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
        if (envContent.includes('TAKEAT_API_KEY=')) {
          envContent = envContent.replace(/TAKEAT_API_KEY=.*/, `TAKEAT_API_KEY=${rawKey}`);
        } else {
          envContent += `\nTAKEAT_API_KEY=${rawKey}\n`;
        }
        writeFileSync(envPath, envContent, 'utf-8');

        // Testa conexão oficial com a Takeat
        try {
          await client.exchangeApiKeyForTokens();
          return sendJson(200, { success: true, message: 'Chave Takeat conectada e validada com sucesso!' });
        } catch (err: any) {
          return sendJson(400, { error: `Takeat recusou a chave: ${err.message}` });
        }
      }

      // 2. Dashboard Stats
      if (pathname === '/api/dashboard' && req.method === 'GET') {
        const insumos = getAllInsumos(db);
        const alertas = getAlertasEstoque(db);
        const pedidos = getPedidosProcessados(db, 5, 0);
        const movimentacoes = getMovimentacoes(db, 5);

        const totalBebidas = insumos.filter((i) => i.categoria === 'bebida').length;
        const totalInsumos = insumos.filter((i) => i.categoria === 'insumo').length;
        const valorTotalEstoque = insumos.reduce((acc, i) => acc + (i.quantidade * (i.preco_unitario || 0)), 0);

        return sendJson(200, {
          total_itens: insumos.length,
          total_bebidas: totalBebidas,
          total_insumos: totalInsumos,
          total_alertas: alertas.length,
          valor_total_estoque: Number(valorTotalEstoque.toFixed(2)),
          alertas_criticos: alertas,
          ultimos_pedidos: pedidos,
          ultimas_movimentacoes: movimentacoes,
        });
      }

      // 3. Insumos & Bebidas
      if (pathname === '/api/insumos' && req.method === 'GET') {
        const cat = parsedUrl.searchParams.get('categoria') || undefined;
        return sendJson(200, getAllInsumos(db, cat));
      }

      if (pathname === '/api/insumos' && req.method === 'POST') {
        const body = await getBody();
        const novo = createInsumo(db, body);
        return sendJson(201, novo);
      }

      // 4. Ajuste / Entrada / Saída Manual de Estoque
      const matchAjuste = pathname.match(/^\/api\/insumos\/(\d+)\/ajuste$/);
      if (matchAjuste && req.method === 'POST') {
        const insumoId = Number(matchAjuste[1]);
        const body = await getBody();
        const delta = parseFloat(body.quantidade);
        const tipo = body.tipo || (delta >= 0 ? 'ENTRADA_COMPRA' : 'AJUSTE_INVENTARIO');
        const desc = body.descricao || 'Ajuste manual via Dashboard';

        const mov = movimentarEstoque(db, insumoId, delta, tipo, 'MANUAL', 'DASHBOARD', desc);
        return sendJson(200, mov);
      }

      // 5. Alertas de Estoque Mínimo
      if (pathname === '/api/alertas' && req.method === 'GET') {
        return sendJson(200, getAlertasEstoque(db));
      }

      // 6. Produtos do Catálogo Takeat
      if (pathname === '/api/produtos' && req.method === 'GET') {
        return sendJson(200, getAllProdutos(db));
      }

      // 7. Complementos do Catálogo Takeat
      if (pathname === '/api/complementos' && req.method === 'GET') {
        return sendJson(200, getAllComplementos(db));
      }

      // 8. Ficha Técnica de Produto
      const matchFichaProd = pathname.match(/^\/api\/fichas\/produto\/(\d+)$/);
      if (matchFichaProd) {
        const prodId = Number(matchFichaProd[1]);
        if (req.method === 'GET') {
          return sendJson(200, getFichaTecnicaProduto(db, prodId));
        }
        if (req.method === 'POST') {
          const body = await getBody();
          saveFichaTecnicaProduto(db, prodId, body.itens || []);
          return sendJson(200, { success: true, itens: getFichaTecnicaProduto(db, prodId) });
        }
      }

      // 9. Ficha Técnica de Complemento
      const matchFichaComp = pathname.match(/^\/api\/fichas\/complemento\/(\d+)$/);
      if (matchFichaComp) {
        const compId = Number(matchFichaComp[1]);
        if (req.method === 'GET') {
          return sendJson(200, getFichaTecnicaComplemento(db, compId));
        }
        if (req.method === 'POST') {
          const body = await getBody();
          saveFichaTecnicaComplemento(db, compId, body.itens || []);
          return sendJson(200, { success: true, itens: getFichaTecnicaComplemento(db, compId) });
        }
      }

      // 10. Vendas e Pedidos Processados com Consumo de Insumos
      if (pathname === '/api/vendas' && req.method === 'GET') {
        const limit = Number(parsedUrl.searchParams.get('limit')) || 50;
        const offset = Number(parsedUrl.searchParams.get('offset')) || 0;
        return sendJson(200, getPedidosProcessados(db, limit, offset));
      }

      // 11. Movimentações / Auditoria Ledger
      if (pathname === '/api/movimentacoes' && req.method === 'GET') {
        const limit = Number(parsedUrl.searchParams.get('limit')) || 100;
        return sendJson(200, getMovimentacoes(db, limit));
      }

      // 12. Sincronização Takeat (Disparos Manuais)
      if (pathname === '/api/sync/insumos' && req.method === 'POST') {
        const result = await syncService.syncInsumos();
        return sendJson(200, result);
      }

      if (pathname === '/api/sync/catalogo' && req.method === 'POST') {
        const result = await syncService.syncCatalogo();
        return sendJson(200, result);
      }

      if (pathname === '/api/sync/vendas' && req.method === 'POST') {
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const sessions = await client.getTableSessions(yesterday.toISOString(), now.toISOString());
        const result = deductionService.processarSessoes(sessions);
        return sendJson(200, result);
      }

      // 13. Seed Demo Data (para testes e apresentação no GitHub)
      if (pathname === '/api/seed-demo' && req.method === 'POST') {
        const { seedDemoData } = await import('../services/seed.ts');
        seedDemoData(db);
        return sendJson(200, { success: true, message: 'Dados de demonstração carregados com sucesso!' });
      }

      // =============================================================
      // ROTAS DA CONTAGEM DIÁRIA DE ESTOQUE (PLANILHA INTELIGENTE)
      // =============================================================

      if (pathname === '/api/contagem/hoje' && req.method === 'GET') {
        const dataQuery = parsedUrl.searchParams.get('data') || undefined;
        const contagem = getOrCreateContagemHoje(db, dataQuery);
        return sendJson(200, contagem);
      }

      if (pathname === '/api/contagem/item' && req.method === 'POST') {
        const body = await getBody();
        const item = atualizarItemContagem(db, Number(body.id), body);
        return sendJson(200, item);
      }

      if (pathname === '/api/contagem/cabecalho' && req.method === 'POST') {
        const body = await getBody();
        const contagem = atualizarCabecalhoContagem(db, Number(body.contagemId), body);
        return sendJson(200, contagem);
      }

      if (pathname === '/api/contagem/adicionar-produto' && req.method === 'POST') {
        const body = await getBody();
        const item = adicionarProdutoContagem(db, Number(body.contagemId), body.nome);
        return sendJson(201, item);
      }

      const matchDelContagemItem = pathname.match(/^\/api\/contagem\/item\/(\d+)$/);
      if (matchDelContagemItem && req.method === 'DELETE') {
        removerProdutoContagem(db, Number(matchDelContagemItem[1]));
        return sendJson(200, { success: true });
      }

      if (pathname === '/api/contagem/historico' && req.method === 'GET') {
        const hist = listarHistoricoContagens(db);
        return sendJson(200, hist);
      }

      if (pathname === '/api/contagem/sync-takeat' && req.method === 'POST') {
        const body = await getBody().catch(() => ({}));
        const contagemId = Number(body.contagemId);
        const contagem = db.prepare('SELECT * FROM contagens_diarias WHERE id = ?').get(contagemId) as any;
        if (!contagem) return sendJson(404, { error: 'Contagem não encontrada' });

        const startIso = `${contagem.data}T00:00:00.000Z`;
        const endIso = `${contagem.data}T23:59:59.999Z`;
        const vendasMap = new Map<string, number>();

        // 1. Tenta buscar direto da API se configurada
        try {
          if (process.env.TAKEAT_API_KEY && process.env.TAKEAT_API_KEY !== 'tk_test_seu_token_aqui') {
            const sessions = await client.getTableSessions(startIso, endIso);
            for (const session of sessions) {
              if (session.status === 'canceled') continue;
              for (const order of (session.orders || [])) {
                if (order.status === 'canceled') continue;
                const nomeNorm = (order.product_name || '').toUpperCase().trim();
                vendasMap.set(nomeNorm, (vendasMap.get(nomeNorm) || 0) + (order.quantity || 1));
              }
            }
          }
        } catch (err: any) {
          console.warn('[SyncTakeatContagem] Falha ao consultar sessões da Takeat:', err.message);
        }

        // 2. Busca também dos pedidos locais
        const pedidosLocais = db.prepare(`
          SELECT produto_nome, SUM(quantidade) as total
          FROM pedidos_processados
          WHERE DATE(data_pedido) = ?
          GROUP BY produto_nome
        `).all(contagem.data) as any[];

        for (const p of pedidosLocais) {
          const nomeNorm = p.produto_nome.toUpperCase().trim();
          if (!vendasMap.has(nomeNorm)) {
            vendasMap.set(nomeNorm, p.total);
          }
        }

        // 3. Atualiza os itens da contagem
        const itens = db.prepare('SELECT * FROM contagem_itens WHERE contagem_id = ?').all(contagemId) as any[];
        let atualizados = 0;

        for (const item of itens) {
          const itemNome = item.nome_produto.toUpperCase();
          let matchQtd = 0;

          for (const [vendaNome, qtd] of vendasMap.entries()) {
            if (vendaNome === itemNome || vendaNome.includes(itemNome) || itemNome.includes(vendaNome)) {
              matchQtd += qtd;
            }
          }

          if (matchQtd > 0 || vendasMap.size > 0) {
            atualizarItemContagem(db, item.id, { venda: matchQtd });
            atualizados++;
          }
        }

        const contagemAtualizada = getOrCreateContagemHoje(db, contagem.data);
        return sendJson(200, {
          success: true,
          message: `${atualizados} produtos atualizados com as vendas do turno!`,
          contagem: contagemAtualizada
        });
      }

      // -------------------------------------------------------------
      // SERVINDO ARQUIVOS ESTÁTICOS DO DASHBOARD (SPA)
      // -------------------------------------------------------------
      if (pathname === '/' || pathname === '/index.html' || !pathname.startsWith('/api')) {
        let indexPath = join(__dirname, 'public', 'index.html');
        if (!existsSync(indexPath)) {
          indexPath = join(process.cwd(), 'index.html');
        }
        if (existsSync(indexPath)) {
          const html = readFileSync(indexPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
      }

      sendJson(404, { error: 'Rota não encontrada' });
    } catch (err: any) {
      console.error('[WebServerError]', err);
      sendJson(500, { error: err.message || 'Erro interno do servidor' });
    }
  });

  return server;
}
