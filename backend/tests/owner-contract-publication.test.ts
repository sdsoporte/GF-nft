import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { request } from './helpers.ts';
import { startOwnerApp, ownerSession, issueGrant, type OwnerApp } from './owner-fixtures.ts';
import { draftParams, expectSuccess, TENANT_B } from './mcp/grant-helper.ts';

const headers = { 'content-type': 'application/json' };
const writeGrant = { phaseMode: 'PHASE_1B_READ_WRITE', scopes: ['contracts:draft', 'market:read'] };
const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' } };
const invalid = { error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid publication request.' } };

async function createDraft(app: OwnerApp, token: string) {
  expectSuccess(await app.handle.mcp!.invokeTool(token, 'draft_supply_offer', draftParams('owner_draft_create_001')));
  app.clock.advance();
  return app.handle.match.engine.getAllContracts()[0];
}
function admission(app: OwnerApp) {
  return { snapshot: app.handle.match.engine.createSnapshot(),
    pending: app.handle.match.engine.getCommandQueue().getPendingCount(),
    sequence: app.handle.match.engine.getCommandQueue().getSequenceCounter(),
    acknowledged: app.handle.match.getAcknowledgedRequestCount() };
}

test('publication requires a live owner session, never root or an MCP grant', async () => {
  let now = Date.UTC(2030, 0, 1);
  const app = await startOwnerApp({ now: () => now });
  try {
    const session = await ownerSession(app);
    const grant = await issueGrant(app, session, writeGrant);
    const draft = await createDraft(app, grant.token);
    const path = `/v1/owner/contracts/${draft.contractId}/publish`;
    const body = JSON.stringify({ idempotency_key: 'publish_auth_001' });
    const before = admission(app);
    for (const token of [undefined, app.token, grant.token, 'gf_owner_forged']) {
      const denied = await request(app, path, { method: 'POST', token, headers, body });
      assert.equal(denied.status, 401);
      assert.deepEqual(denied.json, unauthorized);
      assert.deepEqual(admission(app), before);
    }
    now += 15 * 60 * 1000;
    const expired = await request(app, path, { method: 'POST', token: session, headers, body });
    assert.equal(expired.status, 401);
    assert.deepEqual(expired.json, unauthorized);
    const fresh = await ownerSession(app);
    await request(app, '/v1/owner/sessions/current', { method: 'DELETE', token: fresh });
    const loggedOut = await request(app, path, { method: 'POST', token: fresh, headers, body });
    assert.equal(loggedOut.status, 401);
    assert.deepEqual(loggedOut.json, unauthorized);
    assert.deepEqual(admission(app), before);
  } finally { await app.close(); }
});

test('owner publication validates input and preserves offer terms without locking funds', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const grant = await issueGrant(app, session, writeGrant);
    const draft = structuredClone(await createDraft(app, grant.token));
    const path = `/v1/owner/contracts/${draft.contractId}/publish`;
    const before = admission(app);
    for (const input of [{}, { idempotency_key: 'short' }, { idempotency_key: 'owner_publish_001', companyId: 'foreign' }]) {
      const denied = await request(app, path, { method: 'POST', token: session, headers, body: JSON.stringify(input) });
      assert.equal(denied.status, 400);
      assert.deepEqual(denied.json, invalid);
      assert.deepEqual(admission(app), before);
    }
    const validJson = JSON.stringify({ idempotency_key: 'owner_publish_001' });
    const boundaryBody = validJson + ' '.repeat(8192 - Buffer.byteLength(validJson));
    const oversized = await request(app, path, { method: 'POST', token: session, headers, body: boundaryBody + ' ' });
    assert.equal(oversized.status, 413);
    assert.deepEqual(oversized.json, { error: { code: 'REQUEST_TOO_LARGE', message: 'The request body exceeds 8192 bytes.' } });
    assert.deepEqual(admission(app), before);
    const media = await request(app, path, { method: 'POST', token: session, body: validJson });
    assert.equal(media.status, 415);
    assert.deepEqual(media.json, { error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The publication request must be application/json.' } });
    assert.deepEqual(admission(app), before);
    const malformed = await request(app, path, { method: 'POST', token: session, headers, body: '{bad' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.json, { error: { code: 'INVALID_REQUEST', message: 'The request body must be valid JSON.' } });
    assert.deepEqual(admission(app), before);
    const published = await request(app, path, { method: 'POST', token: session, headers, body: boundaryBody });
    assert.equal(published.status, 202, published.text);
    assert.deepEqual(published.json, { status: 'ENQUEUED_FOR_NEXT_TICK', scheduledTick: app.handle.match.engine.getCurrentTick() + 1, contractId: draft.contractId });
    assert.equal(app.handle.match.engine.getContract(draft.contractId)!.status, 'DRAFT');
    const duplicate = await request(app, path, { method: 'POST', token: session, headers,
      body: JSON.stringify({ idempotency_key: 'owner_publish_001' }) });
    assert.equal(duplicate.status, 409);
    assert.deepEqual(duplicate.json, { error: { code: 'ERR_DUPLICATE_IDEMPOTENCY_KEY', message: 'idempotency_key duplicate' } });
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    app.clock.advance();
    const engine = app.handle.match.engine;
    assert.deepEqual(engine.getContract(draft.contractId), { ...draft, status: 'PENDING' });
    // The tick still regenerates energy normally; publication changes no other company state.
    const expectedCompanies = Object.fromEntries(Object.entries(before.snapshot.companies).map(([id, company]) => [
      id, { ...company, energy: Math.min(company.energy + company.energyGenerationPerTick, company.maxEnergyStorage) },
    ]));
    assert.deepEqual(engine.createSnapshot().companies, expectedCompanies);
    const quotes = expectSuccess(await app.handle.mcp!.invokeTool(grant.token, 'get_market_quotes', {}));
    assert.equal((quotes.data as { quotes: unknown[] }).quotes.length, 1);
    assert.equal(engine.getExecutionHistory().at(-1)!.success, true);
    assert.equal(app.handle.match.getAcknowledgedRequestCount(), 0);
  } finally { await app.close(); }
});

test('publication rejects unknown, foreign and already-published offers before admission', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const grant = await issueGrant(app, session, writeGrant);
    const own = await createDraft(app, grant.token);
    const engine = app.handle.match.engine;
    assert.equal(engine.submitCommand({ commandId: 'foreign_draft_fixture', companyId: TENANT_B,
      scheduledTick: engine.getCurrentTick() + 1, idempotencyKey: 'foreign_draft_fixture_001',
      type: 'DRAFT_SUPPLY_OFFER', itemId: 'STEEL_PLATE', quantity: 1, unitPriceCredits: 10, deadlineTicks: 100 }), true);
    app.clock.advance();
    const foreign = engine.getAllContracts().find(contract => contract.sellerCompanyId === TENANT_B)!;
    const before = admission(app);
    for (const id of ['missing_contract', foreign.contractId]) {
      const denied = await request(app, `/v1/owner/contracts/${id}/publish`, { method: 'POST', token: session,
        headers, body: JSON.stringify({ idempotency_key: 'wrong_owner_publish_001' }) });
      assert.equal(denied.status, 404);
      assert.deepEqual(denied.json, { error: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' } });
      assert.deepEqual(admission(app), before);
    }
    const published = await request(app, `/v1/owner/contracts/${own.contractId}/publish`, { method: 'POST', token: session,
      headers, body: JSON.stringify({ idempotency_key: 'own_once_publish_001' }) });
    assert.equal(published.status, 202);
    app.clock.advance();
    const after = admission(app);
    const repeat = await request(app, `/v1/owner/contracts/${own.contractId}/publish`, { method: 'POST', token: session,
      headers, body: JSON.stringify({ idempotency_key: 'own_repeat_publish_001' }) });
    assert.equal(repeat.status, 404);
    assert.deepEqual(repeat.json, { error: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' } });
    assert.deepEqual(admission(app), after);
  } finally { await app.close(); }
});

test('publication support preserves existing owner administration with publication-shaped input', async () => {
  const app = await startOwnerApp();
  try {
    const body = JSON.stringify({ idempotency_key: 'compat_owner_0001' });
    const before = admission(app);
    const login = await request(app, '/v1/owner/sessions', { method: 'POST', token: app.token, headers, body });
    assert.equal(login.status, 201);
    assert.equal(login.json.ownerId, app.ownerId);
    assert.match(login.json.token, /^gf_owner_[a-f0-9]{64}$/);
    const session = login.json.token as string;
    const query = '?idempotency_key=compat_owner_0001';
    const empty = await request(app, `/v1/owner/grants${query}`, { token: session });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json, { grants: [] });
    const invalidIssue = await request(app, '/v1/owner/grants', { method: 'POST', token: session, headers, body });
    assert.equal(invalidIssue.status, 400);
    assert.deepEqual(invalidIssue.json, { error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid grant policy.' } });
    const issued = await issueGrant(app, session);
    const listed = await request(app, `/v1/owner/grants${query}`, { token: session });
    assert.deepEqual(listed.json, { grants: [issued.grant] });
    const get = await request(app, `/v1/owner/grants/${issued.grant.grantId}${query}`, { token: session });
    assert.equal(get.status, 200);
    assert.deepEqual(get.json, { grant: issued.grant });
    assert.equal(get.text.includes(issued.token), false);
    const revoked = await request(app, `/v1/owner/grants/${issued.grant.grantId}${query}`, {
      method: 'DELETE', token: session, headers, body,
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json, { revoked: true });
    const logout = await request(app, '/v1/owner/sessions/current', { method: 'DELETE', token: session, headers, body });
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.json, { revoked: true });
    const denied = await request(app, `/v1/owner/grants${query}`, { token: session });
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.json, unauthorized);
    assert.deepEqual(admission(app), before);
  } finally { await app.close(); }
});

test('drafts and queued human publication survive isolated backend restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gf-draft-publication-'));
  const path = join(directory, 'match.sqlite');
  let app = await startOwnerApp({ path });
  try {
    const session = await ownerSession(app);
    const grant = await issueGrant(app, session, writeGrant);
    const draft = structuredClone(await createDraft(app, grant.token));
    assert.equal(draft.status, 'DRAFT');
    await app.close();
    app = await startOwnerApp({ path });
    assert.deepEqual(app.handle.match.engine.getContract(draft.contractId), draft);
    const fresh = await ownerSession(app);
    const published = await request(app, `/v1/owner/contracts/${draft.contractId}/publish`, {
      method: 'POST', token: fresh, headers, body: JSON.stringify({ idempotency_key: 'durable_publish_001' }),
    });
    assert.equal(published.status, 202, published.text);
    await app.close();
    app = await startOwnerApp({ path });
    assert.equal(app.handle.match.engine.getContract(draft.contractId)!.status, 'DRAFT');
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    app.clock.advance();
    assert.deepEqual(app.handle.match.engine.getContract(draft.contractId), { ...draft, status: 'PENDING' });
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
    assert.equal(app.handle.match.engine.getExecutionHistory().at(-1)!.success, true);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
