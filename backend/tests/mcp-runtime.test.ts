import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from './helpers.ts';
import { startOwnerApp, ownerSession, issueGrant } from './owner-fixtures.ts';
import { ALL_SCOPES, LINE_A1, LINE_A2, LINE_A3, TENANT_A, expectError, expectSuccess, targetParams, makeGrant } from './mcp/grant-helper.ts';

const tools = ['get_factory_overview', 'get_inventory', 'get_production_lines', 'get_contracts', 'get_market_quotes', 'get_action_history', 'set_production_target', 'set_line_priority', 'pause_production_line', 'resume_production_line', 'schedule_internal_transport', 'draft_supply_offer', 'cancel_own_pending_offer'];
const writeGrant = { phaseMode: 'PHASE_1B_READ_WRITE', scopes: ALL_SCOPES };

for (const state of ['expired', 'revoked'] as const) {
  test(`stored ${state} grant rejects all thirteen operations without state/queue/ack changes`, async () => {
    let now = Date.UTC(2030, 0, 1);
    const app = await startOwnerApp({ now: () => now });
    try {
      const session = await ownerSession(app);
      const issued = await issueGrant(app, session, { ...writeGrant, ttlMs: 1000 });
      if (state === 'expired') now += 1000;
      else assert.equal((await request(app, `/v1/owner/grants/${issued.grant.grantId}`, { method: 'DELETE', token: session })).status, 200);
      const before = app.handle.match.engine.createSnapshot();
      for (const tool of tools) {
        const response = expectError(await app.handle.mcp!.invokeTool(issued.token, tool, { company_id: TENANT_A }), state === 'expired' ? 'ERR_AUTH_EXPIRED' : 'ERR_AUTH_REVOKED');
        assert.equal(response.tool, tool);
        assert.equal('data' in response, false);
      }
      assert.deepEqual(app.handle.match.engine.createSnapshot(), before);
      assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
      assert.equal(app.handle.match.getAcknowledgedRequestCount(), 0);
      assert.equal(app.handle.mcp!.getAuditLogs().length, tools.length);
    } finally { await app.close(); }
  });
}

test('gateway uses stored scopes, quota and allowlist without raw-token registration', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const limited = await issueGrant(app, session, { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], quotas: { maxReadPerMinute: 1 } });
    expectError(await app.handle.mcp!.invokeTool(limited.token, 'get_inventory', { company_id: TENANT_A }), 'ERR_SCOPE_UNAUTHORIZED');
    expectSuccess(await app.handle.mcp!.invokeTool(limited.token, 'get_factory_overview', { company_id: TENANT_A }));
    expectError(await app.handle.mcp!.invokeTool(limited.token, 'get_factory_overview', { company_id: TENANT_A }), 'ERR_RATE_LIMIT_EXCEEDED');
    const narrow = await issueGrant(app, session, { ...writeGrant, resourceAllowlist: [LINE_A1], quotas: { maxWritePerMinute: 1 } });
    expectError(await app.handle.mcp!.invokeTool(narrow.token, 'set_production_target', targetParams(LINE_A2, 'idem_not_allowed')), 'ERR_RESOURCE_NOT_ALLOWED');
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
    expectSuccess(await app.handle.mcp!.invokeTool(narrow.token, 'set_production_target', targetParams(LINE_A1, 'idem_allowed')));
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    assert.deepEqual(app.handle.mcp!.getAllGrants(), []);
  } finally { await app.close(); }
});

test('fixture/demo credentials never access a real server match', async () => {
  const app = await startOwnerApp();
  try {
    const before = app.handle.match.engine.createSnapshot();
    assert.throws(() => app.handle.mcp!.registerGrant(makeGrant()), /server-managed/);
    assert.deepEqual(app.handle.mcp!.getAllGrants(), []);
    for (const token of ['gf_mcp_metal01_live_token', 'gf_mcp_manuf01_readonly_token', 'gf_mcp_mock_' + 'a'.repeat(43)]) {
      expectError(await app.handle.mcp!.invokeTool(token, 'get_inventory', { company_id: TENANT_A }), 'ERR_AUTH_INVALID');
    }
    assert.deepEqual(app.handle.match.engine.createSnapshot(), before);
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
  } finally { await app.close(); }
});

test('grant policy and accepted MCP commands survive restart before a tick, without using HTTP ack capacity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gf-mcp-restart-'));
  const path = join(directory, 'match.db');
  let app = await startOwnerApp({ path });
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session, writeGrant);
    const matchId = app.handle.match.matchId;
    expectSuccess(await app.handle.mcp!.invokeTool(issued.token, 'set_production_target', targetParams(LINE_A1, 'idem_restart_mcp')));
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    assert.equal(app.handle.match.getAcknowledgedRequestCount(), 0);
    await app.close();
    app = await startOwnerApp({ path });
    assert.equal(app.handle.match.matchId, matchId);
    assert.equal((await request(app, '/v1/owner/grants', { token: session })).status, 401);
    expectSuccess(await app.handle.mcp!.invokeTool(issued.token, 'get_inventory', { company_id: TENANT_A }));
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    expectError(await app.handle.mcp!.invokeTool(issued.token, 'set_production_target', targetParams(LINE_A1, 'idem_restart_mcp')), 'ERR_DUPLICATE_IDEMPOTENCY_KEY');
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    app.clock.advance();
    const history = app.handle.match.engine.getCompanyExecutionHistory(TENANT_A);
    assert.equal(history.length, 1); assert.equal(history[0].success, true);
    assert.equal(app.handle.match.engine.getCompany(TENANT_A)!.lines[0].status, 'RUNNING');
    assert.equal(app.handle.match.getAcknowledgedRequestCount(), 0);
    await app.close();
    app = await startOwnerApp({ path });
    assert.deepEqual(app.handle.match.engine.getCompanyExecutionHistory(TENANT_A), history);
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});


test('line cooldown survives a backend restart (issue #15)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gf-mcp-cooldown-'));
  const path = join(directory, 'match.db');
  let app = await startOwnerApp({ path });
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session, writeGrant);
    expectSuccess(await app.handle.mcp!.invokeTool(issued.token, 'set_production_target', targetParams(LINE_A1, 'idem_cd_first')));
    app.clock.advance();
    assert.equal(app.handle.match.engine.getCurrentTick(), 1);
    await app.close();

    app = await startOwnerApp({ path });
    assert.equal(app.handle.match.engine.getCurrentTick(), 1);
    // The line cooldown is 5 ticks; only 1 elapsed, so the re-target must be
    // rejected even though the cooldown Map started empty after the restart.
    const rejected = expectError(
      await app.handle.mcp!.invokeTool(issued.token, 'set_production_target', targetParams(LINE_A1, 'idem_cd_second')),
      'ERR_INVALID_PAYLOAD'
    );
    assert.match(rejected.errorMessage, /ERR_COOLDOWN_ACTIVE/);
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);

    // Positive control: once the batch finished (tick 10) and the cooldown
    // elapsed, the same line accepts a new target again.
    app.clock.advance(9);
    assert.equal(app.handle.match.engine.getCurrentTick(), 10);
    expectSuccess(await app.handle.mcp!.invokeTool(issued.token, 'set_production_target', targetParams(LINE_A1, 'idem_cd_third')));
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('write rate limit and match write quota survive a backend restart (issue #15)', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gf-mcp-quota-'));
  const path = join(directory, 'match.db');
  let app = await startOwnerApp({ path });
  try {
    const session = await ownerSession(app);
    const rateLimited = await issueGrant(app, session, { ...writeGrant, quotas: { maxWritePerMinute: 1, maxWritePerMatch: 10 } });
    const matchQuota = await issueGrant(app, session, { ...writeGrant, quotas: { maxWritePerMinute: 60, maxWritePerMatch: 1 } });
    // First accepted write per grant. Cooldowns are per line (not per grant),
    // so the two grants take different lines.
    expectSuccess(await app.handle.mcp!.invokeTool(rateLimited.token, 'set_production_target', targetParams(LINE_A1, 'idem_rate_first')));
    expectSuccess(await app.handle.mcp!.invokeTool(matchQuota.token, 'set_production_target', targetParams(LINE_A2, 'idem_match_first')));
    await app.close();

    app = await startOwnerApp({ path });
    // Drain the queued first writes and let the tick-0 line cooldowns elapse;
    // the wall-clock rate window cannot have expired.
    app.clock.advance(5);
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
    // The per-minute window cannot have expired, so the second write must
    // still hit the persisted rate limit instead of evading it. LINE_A3 was
    // never written, so no cooldown interferes with the quota assertions.
    const rate = expectError(
      await app.handle.mcp!.invokeTool(rateLimited.token, 'set_production_target', targetParams(LINE_A3, 'idem_rate_second')),
      'ERR_RATE_LIMIT_EXCEEDED'
    );
    assert.match(rate.errorMessage, /Write rate limit exceeded \(1\/min\)/);
    const quota = expectError(
      await app.handle.mcp!.invokeTool(matchQuota.token, 'set_production_target', targetParams(LINE_A3, 'idem_match_second')),
      'ERR_RATE_LIMIT_EXCEEDED'
    );
    assert.match(quota.errorMessage, /Match write quota exceeded \(1\/match\)/);
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('concurrent duplicate requests enqueue at most one command (issue #15)', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session, writeGrant);
    const attempts = Array.from({ length: 12 }, () =>
      app.handle.mcp!.invokeTool(issued.token, 'set_production_target', targetParams(LINE_A1, 'idem_concurrent_burst'))
    );
    const responses = await Promise.all(attempts);
    const enqueued = responses.filter((response) => response.success);
    assert.equal(enqueued.length, 1, 'exactly one concurrent attempt may enqueue');
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    assert.equal(app.handle.match.engine.getCommandQueue().getSequenceCounter(), 1);
    for (const response of responses.filter((item) => !item.success)) {
      assert.equal(response.errorCode, 'ERR_DUPLICATE_IDEMPOTENCY_KEY');
    }
    // The single queued command executes once and its escrow is recorded once.
    app.clock.advance(1);
    const history = app.handle.match.engine.getCompanyExecutionHistory(TENANT_A);
    assert.equal(history.length, 1);
    assert.equal(history[0].success, true);
  } finally { await app.close(); }
});

test('changing the configured owner cannot expose, revoke or use another owner persisted grant', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gf-mcp-owner-'));
  const path = join(directory, 'match.db');
  let app = await startOwnerApp({ path, ownerId: 'owner_first' });
  try {
    const issued = await issueGrant(app, await ownerSession(app));
    await app.close();
    app = await startOwnerApp({ path, ownerId: 'owner_second' });
    const session = await ownerSession(app);
    assert.deepEqual((await request(app, '/v1/owner/grants', { token: session })).json, { grants: [] });
    for (const method of ['GET', 'DELETE']) {
      const response = await request(app, `/v1/owner/grants/${issued.grant.grantId}`, { method, token: session });
      assert.equal(response.status, 404);
    }
    expectError(await app.handle.mcp!.invokeTool(issued.token, 'get_inventory', { company_id: TENANT_A }), 'ERR_AUTH_INVALID');
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
    await app.close();
    app = await startOwnerApp({ path, ownerId: 'owner_first' });
    const restored = await request(app, `/v1/owner/grants/${issued.grant.grantId}`, { token: await ownerSession(app) });
    assert.equal(restored.status, 200); assert.deepEqual(restored.json, { grant: issued.grant });
    expectSuccess(await app.handle.mcp!.invokeTool(issued.token, 'get_inventory', { company_id: TENANT_A }));
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
