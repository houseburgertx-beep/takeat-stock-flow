import { getDatabase } from './db/database.ts';
import { TakeatClient } from './takeat/client.ts';
import { createWebServer } from './web/server.ts';
import { DeductionService } from './services/deduction.ts';

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DATABASE_PATH || './data/estoque.db';
const AUTO_TRACK_INTERVAL = Number(process.env.AUTO_TRACK_INTERVAL_MINUTES) || 5;

async function bootstrap() {
  console.log('\n======================================================');
  console.log('🚀 INICIANDO TAKEA T STOCK FLOW - API V1.0');
  console.log('======================================================');

  const db = getDatabase(DB_PATH);
  console.log(`[DB] Banco de dados SQLite inicializado em: ${DB_PATH}`);

  const client = new TakeatClient({ db });
  const server = createWebServer(db, client);

  server.listen(PORT, () => {
    console.log(`[HTTP] Servidor Web & API rodando com sucesso!`);
    console.log(`[DASHBOARD] Acesse no navegador: http://localhost:${PORT}`);
    console.log(`[INFO] Para usar com dados reais da Takeat, configure o arquivo .env`);
    console.log(`       Para testar imediatamente, clique em "Dados Demo" no dashboard.`);
    console.log('------------------------------------------------------\n');
  });

  // Agendador de rastreamento automático de vendas
  if (AUTO_TRACK_INTERVAL > 0 && process.env.TAKEAT_API_KEY && process.env.TAKEAT_API_KEY !== 'tk_test_seu_token_aqui') {
    console.log(`[Cron] Agendador ativo: verificando vendas a cada ${AUTO_TRACK_INTERVAL} minuto(s)...`);
    const deductionService = new DeductionService(db);

    setInterval(async () => {
      try {
        const now = new Date();
        const past = new Date(now.getTime() - AUTO_TRACK_INTERVAL * 2 * 60 * 1000);
        const sessions = await client.getTableSessions(past.toISOString(), now.toISOString());
        const res = deductionService.processarSessoes(sessions);
        if (res.pedidosProcessados > 0) {
          console.log(`[AutoTrack] ${res.pedidosProcessados} novos pedidos processados automaticamente.`);
        }
      } catch (err: any) {
        console.warn(`[AutoTrack Warn] Falha na checagem periódica: ${err.message}`);
      }
    }, AUTO_TRACK_INTERVAL * 60 * 1000);
  }
}

bootstrap().catch((err) => {
  console.error('Erro fatal ao iniciar aplicação:', err);
  process.exit(1);
});
