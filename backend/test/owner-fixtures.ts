import assert from 'node:assert/strict';
import { createFactoryServer } from '../src/http.ts';
import { ManualTickClock } from '../src/clock.ts';
import { openDatabase, closeDatabase } from '../../src/persistence/database.ts';
import { migrate } from '../../src/persistence/migrations.ts';
import { createMatchStore } from '../../src/persistence/matchStore.ts';
import { request, TEST_TOKEN, type TestApp } from './helpers.ts';

export const OWNER_ID = 'owner_local_test';
export interface OwnerApp extends TestApp { readonly ownerId: string }
export async function startOwnerApp(options: { path?: string; ownerId?: string; now?: () => number } = {}): Promise<OwnerApp> {
  const database = openDatabase(options.path ?? ':memory:');
  migrate(database);
  const clock = new ManualTickClock(1000);
  const ownerId = options.ownerId ?? OWNER_ID;
  const handle = createFactoryServer({ token: TEST_TOKEN, ownerId, securityNow: options.now,
    clock, store: createMatchStore(database), matchId: 'match_owner_test' });
  const address = await handle.listen({ host: '127.0.0.1', port: 0 });
  let closed = false;
  return { handle, clock, ownerId, token: TEST_TOKEN, baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => { if (closed) return; closed = true; await handle.close(); closeDatabase(database); } };
}
export async function ownerSession(app: OwnerApp): Promise<string> {
  const response = await request(app, '/v1/owner/sessions', { method: 'POST', token: app.token });
  assert.equal(response.status, 201, response.text);
  assert.equal(response.json.ownerId, app.ownerId);
  assert.match(response.json.token, /^gf_owner_[a-f0-9]{64}$/);
  assert.equal(response.text.includes(app.token), false);
  return response.json.token;
}
export const READ_GRANT = { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read', 'inventory:read', 'market:read'] };
export async function issueGrant(app: OwnerApp, session: string, input: unknown = READ_GRANT): Promise<{ token: string; grant: any }> {
  const response = await request(app, '/v1/owner/grants', { method: 'POST', token: session,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 201, response.text);
  assert.match(response.json.token, /^gf_mcp_[A-Za-z0-9_-]{43}$/);
  assert.equal('token' in response.json.grant, false);
  assert.equal('tokenHash' in response.json.grant, false);
  return response.json;
}
