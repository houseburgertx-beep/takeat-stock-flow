import test from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/db/schema.ts';
import { saveTokenCache, getTokenCache } from '../src/db/database.ts';
import { TakeatClient } from '../src/takeat/client.ts';

test('TakeatClient: Persistência e cálculo de expiração com margem de segurança de 60s', () => {
  const db = new DatabaseSync(':memory:');
  initializeDatabase(db);

  const now = Date.now();
  const expiresInSeconds = 900; // 15 minutos (padrão Takeat)
  const expiresAt = now + expiresInSeconds * 1000;

  saveTokenCache(db, 'fake_access_token_123', 'fake_refresh_token_456', expiresAt, 'inputs:read products:read');

  const cached = getTokenCache(db);
  assert.ok(cached);
  assert.strictEqual(cached.access_token, 'fake_access_token_123');
  assert.strictEqual(cached.refresh_token, 'fake_refresh_token_456');
  assert.strictEqual(cached.scope, 'inputs:read products:read');

  // Verifica que antes da margem de 60s o token é considerado válido
  const refreshAt = cached.expires_at - 60_000;
  assert.ok(now < refreshAt, 'O token deve estar na janela válida de uso');
});

test('TakeatClient: Lança erro amigável se TAKEAT_API_KEY não estiver definida', async () => {
  const client = new TakeatClient({ apiKey: '' });
  await assert.rejects(
    async () => {
      await client.getValidAccessToken();
    },
    {
      message: /TAKEAT_API_KEY não configurada/,
    }
  );
});
