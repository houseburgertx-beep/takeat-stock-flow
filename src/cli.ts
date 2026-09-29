import { getDatabase, getAllInsumos, getAlertasEstoque } from './db/database.ts';
import { TakeatClient } from './takeat/client.ts';
import { SyncService } from './services/sync.ts';
import { DeductionService } from './services/deduction.ts';
import { seedDemoData } from './services/seed.ts';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  const db = getDatabase();
  const client = new TakeatClient({ db });
  const syncService = new SyncService(db, client);
  const deductionService = new DeductionService(db);

  console.log('\n📦 Takeat Stock Flow - CLI Tool');
  console.log('====================================');

  try {
    switch (command) {
      case 'status': {
        const insumos = getAllInsumos(db);
        const alertas = getAlertasEstoque(db);

        console.log(`\n📊 Status do Estoque Local:`);
        console.log(`- Total de itens cadastrados: ${insumos.length}`);
        console.log(`- Alertas de reposição: ${alertas.length}`);

        if (alertas.length > 0) {
          console.log('\n⚠️  ITENS COM ESTOQUE CRÍTICO:');
          for (const a of alertas) {
            console.log(`  * ${a.insumo_nome} | Saldo: ${a.saldo_atual} ${a.unidade} (Mínimo: ${a.estoque_minimo} ${a.unidade}) - Déficit: ${a.deficit}`);
          }
        } else {
          console.log('✅ Todos os itens estão com estoque seguro!');
        }
        break;
      }

      case 'sync': {
        console.log('\n🔄 Iniciando sincronização com a API Takeat...');
        console.log('1. Sincronizando catálogo de produtos e complementos (/v1/products & /v1/complements)...');
        const catRes = await syncService.syncCatalogo();
        console.log(`   ✅ ${catRes.produtos} produtos e ${catRes.complementos} complementos sincronizados.`);

        console.log('2. Sincronizando insumos e estoque oficial (/v1/inputs)...');
        const insRes = await syncService.syncInsumos();
        console.log(`   ✅ ${insRes.total} insumos processados (${insRes.criados} novos, ${insRes.atualizados} atualizados).`);
        break;
      }

      case 'track': {
        console.log('\n🛒 Rastreando vendas recentes na Takeat (/v1/table-sessions)...');
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const sessions = await client.getTableSessions(yesterday.toISOString(), now.toISOString());
        console.log(`- Sessões recebidas: ${sessions.length}`);

        const result = deductionService.processarSessoes(sessions);
        console.log(`- Pedidos novos processados: ${result.pedidosProcessados}`);
        console.log(`- Pedidos já processados/cancelados: ${result.pedidosPulados}`);

        if (result.itensConsumidos.length > 0) {
          console.log('\n📉 Insumos deduzidos:');
          for (const item of result.itensConsumidos) {
            console.log(`  * ${item.insumo_nome}: -${item.quantidade_consumida} ${item.unidade} (Novo saldo: ${item.saldo_restante} ${item.unidade})`);
          }
        } else {
          console.log('Nenhum insumo baixado nesta rodada.');
        }

        if (result.alertasEstoque.length > 0) {
          console.log(`\n⚠️  Atenção: ${result.alertasEstoque.length} itens atingiram nível mínimo de estoque!`);
        }
        break;
      }

      case 'seed-demo': {
        console.log('\n🌱 Populando dados de demonstração realistas...');
        seedDemoData(db);
        console.log('✅ Base populada com sucesso! Itens, bebidas, fichas técnicas e vendas de exemplo criados.');
        break;
      }

      case 'help':
      default: {
        console.log(`
Uso: node src/cli.ts <comando>

Comandos disponíveis:
  status       Exibe resumo do estoque e alertas de reposição
  sync         Sincroniza insumos e catálogo de produtos da Takeat
  track        Rastreia vendas recentes da Takeat e dá baixa de estoque
  seed-demo    Popula o banco local com itens, receitas e vendas de exemplo
  help         Exibe esta mensagem de ajuda
        `);
        break;
      }
    }
  } catch (err: any) {
    console.error(`\n❌ Erro ao executar '${command}':`, err.message);
    process.exit(1);
  }

  console.log('\nOperação concluída.\n');
}

main();
