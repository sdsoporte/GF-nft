import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request, withTestServer, TEST_TOKEN } from './helpers.ts';
import { createFactoryServer } from '../src/http.ts';
import { ManualTickClock } from '../src/clock.ts';
import { expectSuccess } from '../../tests/mcp/grant-helper.ts';
import { startOwnerApp, ownerSession, issueGrant, READ_GRANT } from './owner-fixtures.ts';

test('configured owner administration also works in the explicitly non-persistent backend mode', async () => {
  const clock = new ManualTickClock(1000);
  const handle = createFactoryServer({ token: TEST_TOKEN, ownerId: 'owner_memory', clock });
  const address = await handle.listen({ host: '127.0.0.1', port: 0 });
  const app = { handle, clock, ownerId: 'owner_memory', token: TEST_TOKEN,
    baseUrl: `http://127.0.0.1:${address.port}`, close: () => handle.close() };
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session);
    expectSuccess(await handle.mcp!.invokeTool(issued.token, 'get_inventory', { company_id: handle.match.getServerCompany().companyId }));
  } finally { await handle.close(); }
});

const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' } };

test('legacy backend defaults remain unchanged and owner routes are opt-in', async () => {
  await withTestServer(async app => {
    const state = await request(app, '/v1/state', { token: app.token });
    assert.equal(state.status, 200);
    assert.equal(app.handle.mcp, undefined);
    const owner = await request(app, '/v1/owner/grants', { token: app.token });
    assert.equal(owner.status, 404);
    assert.deepEqual(owner.json, { error: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' } });
  });
});

test('owner session exchange requires root authentication and returns no-store one-time delivery', async () => {
  const app = await startOwnerApp();
  try {
    for (const token of [undefined, 'gf_owner_forged', 'wrong-root-token']) {
      const denied = await request(app, '/v1/owner/sessions', { method: 'POST', token });
      assert.equal(denied.status, 401);
      assert.deepEqual(denied.json, unauthorized);
    }
    const response = await fetch(`${app.baseUrl}/v1/owner/sessions`, { method: 'POST', headers: { authorization: `Bearer ${app.token}` } });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.json() as any;
    assert.equal(body.ownerId, app.ownerId);
    assert.match(body.token, /^gf_owner_[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(body).sort(), ['expiresAtUtc', 'ownerId', 'token']);
  } finally { await app.close(); }
});

test('every grant administration operation requires an active owner session, not the root token', async () => {
  const app = await startOwnerApp();
  try {
    for (const [method, path] of [['GET', '/v1/owner/grants'], ['POST', '/v1/owner/grants'], ['GET', '/v1/owner/grants/unknown'], ['DELETE', '/v1/owner/grants/unknown']]) {
      for (const token of [undefined, app.token, 'gf_owner_forged']) {
        const denied = await request(app, path, { method, token, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(READ_GRANT) } : {}) });
        assert.equal(denied.status, 401, `${method} ${path}`);
        assert.deepEqual(denied.json, unauthorized);
      }
    }
    const session = await ownerSession(app);
    const list = await request(app, '/v1/owner/grants', { token: session });
    assert.deepEqual(list.json, { grants: [] });
  } finally { await app.close(); }
});

test('grant secrets are delivered once and list/get contain server-selected identity without secrets or hashes', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session);
    assert.equal(issued.grant.playerId, app.ownerId);
    assert.equal(issued.grant.matchId, app.handle.match.matchId);
    assert.equal(issued.grant.companyId, app.handle.match.getServerCompany().companyId);
    const list = await request(app, '/v1/owner/grants', { token: session });
    const get = await request(app, `/v1/owner/grants/${issued.grant.grantId}`, { token: session });
    assert.equal(list.status, 200); assert.equal(get.status, 200);
    assert.deepEqual(list.json, { grants: [issued.grant] });
    assert.deepEqual(get.json, { grant: issued.grant });
    for (const response of [list, get]) {
      assert.equal(response.text.includes(issued.token), false);
      assert.equal(response.text.includes('tokenHash'), false);
      assert.equal(response.text.includes('"token"'), false);
    }
    const revoked = await request(app, `/v1/owner/grants/${issued.grant.grantId}`, { method: 'DELETE', token: session });
    assert.equal(revoked.status, 200); assert.deepEqual(revoked.json, { revoked: true });
    const unknown = await request(app, '/v1/owner/grants/unknown', { token: session });
    assert.equal(unknown.status, 404);
  } finally { await app.close(); }
});

test('malformed or identity-smuggling issue requests never create grants or disclose their values', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    for (const field of ['ownerId', 'playerId', 'companyId', 'matchId', 'token', 'revoked']) {
      const response = await request(app, '/v1/owner/grants', { method: 'POST', token: session,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...READ_GRANT, [field]: 'do-not-echo-this-value' }) });
      assert.equal(response.status, 400);
      assert.deepEqual(response.json, { error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid grant policy.' } });
      assert.equal(response.text.includes('do-not-echo'), false);
      assert.deepEqual((await request(app, '/v1/owner/grants', { token: session })).json, { grants: [] });
    }
    for (const [headers, body, status] of [[{}, '{}', 415], [{ 'content-type': 'application/json' }, '{bad', 400], [{ 'content-type': 'application/json' }, ' '.repeat(8193), 413]] as const) {
      const response = await request(app, '/v1/owner/grants', { method: 'POST', token: session, headers, body });
      assert.equal(response.status, status);
      assert.deepEqual((await request(app, '/v1/owner/grants', { token: session })).json, { grants: [] });
    }
    assert.equal(app.handle.match.getAcknowledgedRequestCount(), 0);
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
  } finally { await app.close(); }
});

test('owner sessions expire at the exact deadline and logout revokes immediately', async () => {
  let now = Date.UTC(2030, 0, 1);
  const app = await startOwnerApp({ now: () => now });
  try {
    const session = await ownerSession(app);
    now += 15 * 60 * 1000 - 1;
    assert.equal((await request(app, '/v1/owner/grants', { token: session })).status, 200);
    now++;
    const expired = await request(app, '/v1/owner/grants', { token: session });
    assert.equal(expired.status, 401); assert.deepEqual(expired.json, unauthorized);
    const fresh = await ownerSession(app);
    const logout = await request(app, '/v1/owner/sessions/current', { method: 'DELETE', token: fresh });
    assert.equal(logout.status, 200); assert.deepEqual(logout.json, { revoked: true });
    assert.equal((await request(app, '/v1/owner/grants', { token: fresh })).status, 401);
  } finally { await app.close(); }
});


test('8192-byte issue bodies succeed and 8193-byte bodies leave the grant collection unchanged', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const input = JSON.stringify(READ_GRANT);
    const body = input + ' '.repeat(8192 - Buffer.byteLength(input));
    const created = await request(app, '/v1/owner/grants', { method: 'POST', token: session,
      headers: { 'content-type': 'application/json' }, body });
    assert.equal(created.status, 201);
    const before = await request(app, '/v1/owner/grants', { token: session });
    assert.equal(before.json.grants.length, 1);
    const rejected = await request(app, '/v1/owner/grants', { method: 'POST', token: session,
      headers: { 'content-type': 'application/json' }, body: body + ' ' });
    assert.equal(rejected.status, 413);
    assert.deepEqual(rejected.json, { error: { code: 'REQUEST_TOO_LARGE', message: 'The request body exceeds 8192 bytes.' } });
    assert.deepEqual((await request(app, '/v1/owner/grants', { token: session })).json, before.json);
    assert.equal(app.handle.match.getAcknowledgedRequestCount(), 0);
  } finally { await app.close(); }
});
