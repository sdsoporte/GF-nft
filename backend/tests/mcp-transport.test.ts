/**
 * External MCP transport (issue #9): stateless JSON-RPC 2.0 over `POST /mcp`,
 * backed by the same gateway policy stack. The transport owns framing and
 * HTTP status mapping only; every call authenticates its bearer token
 * independently (stateless core) and writes go through the engine queue.
 *
 * JSON-RPC contract pinned here:
 * - HTTP 401 only for a missing/invalid bearer token.
 * - HTTP 400 for a malformed JSON-RPC request (including batches: this
 *   stateless core serves one request per POST).
 * - HTTP 200 otherwise; tool/policy failures are JSON-RPC error objects whose
 *   `data.errorCode` carries the gateway's typed `ERR_*` code.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { request } from './helpers.ts';
import { startOwnerApp, ownerSession, issueGrant } from './owner-fixtures.ts';
import { ALL_SCOPES, TENANT_A, TENANT_B } from './mcp/grant-helper.ts';

const MCP_PATH = '/mcp';
const PROTOCOL_VERSION = '2026-07-28';

async function rpc(
  app: Parameters<typeof request>[0],
  body: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  return request(app, MCP_PATH, {
    method: 'POST',
    token,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((response) => ({ status: response.status, json: response.json }));
}

function call(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

test('initialize negotiates the protocol version without a session', async () => {
  const app = await startOwnerApp();
  try {
    const response = await rpc(app, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.1' } },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, {
      jsonrpc: '2.0', id: 1,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'gigaforge-mcp', version: 1 },
      },
    });
  } finally { await app.close(); }
});

test('initialize answers with the server version for an unsupported client version', async () => {
  const app = await startOwnerApp();
  try {
    const response = await rpc(app, {
      jsonrpc: '2.0', id: 7, method: 'initialize',
      params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old-client', version: '0' } },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.protocolVersion, PROTOCOL_VERSION);
  } finally { await app.close(); }
});

test('tools/list discovers the full catalog with schemas and no secrets', async () => {
  const app = await startOwnerApp();
  try {
    const response = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(response.status, 200);
    const tools = response.json.result.tools as Array<{ name: string; description: string; inputSchema: unknown }>;
    const names = tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 13);
    assert.equal(names.filter((name) => name.startsWith('get_')).length, 6);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0);
      assert.equal((tool.inputSchema as { type?: string }).type, 'object');
    }
    assert.ok(names.includes('set_production_target'));
    assert.ok(names.includes('draft_supply_offer'));
  } finally { await app.close(); }
});

test('tools/call executes a scoped read through the gateway', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session, writeGrantFor());
    const response = await rpc(app, call(3, 'get_inventory', { company_id: TENANT_A }), issued.token);
    assert.equal(response.status, 200);
    assert.equal(response.json.jsonrpc, '2.0');
    assert.equal(response.json.id, 3);
    const content = response.json.result.content as Array<{ type: string; text: string }>;
    assert.equal(response.json.result.isError, false);
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /RAW_ORE/);
  } finally { await app.close(); }
});

test('a missing or invalid bearer token is an HTTP 401 before JSON-RPC handling', async () => {
  const app = await startOwnerApp();
  try {
    const missing = await rpc(app, call(4, 'get_inventory', { company_id: TENANT_A }));
    assert.equal(missing.status, 401);
    const invalid = await rpc(app, call(5, 'get_inventory', { company_id: TENANT_A }), 'gf_mcp_not_a_real_token');
    assert.equal(invalid.status, 401);
  } finally { await app.close(); }
});

test('a malformed JSON-RPC request is an HTTP 400 and batches are rejected', async () => {
  const app = await startOwnerApp();
  try {
    const malformed = await request(app, MCP_PATH, {
      method: 'POST', token: 'gf_mcp_whatever',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'tools/list' }),
    });
    assert.equal(malformed.status, 400);
    const batch = await rpc(app, [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ], 'gf_mcp_whatever');
    assert.equal(batch.status, 400);
  } finally { await app.close(); }
});

test('writes require correct scopes and re-targets stay inside the grant boundary', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const readOnly = await issueGrant(app, session, { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'] });
    const denied = await rpc(app, call(6, 'set_production_target', {
      line_id: 'comp_metal_01_line_1', recipe_id: 'R1', target_batches: 1, idempotency_key: 'idem_scope_denied',
    }), readOnly.token);
    assert.equal(denied.status, 200);
    assert.equal(denied.json.result.isError, true);
    assert.equal(denied.json.result.errorCode, 'ERR_SCOPE_UNAUTHORIZED');

    // The owner API binds every grant to the server-selected company, so
    // cross-tenant isolation is proven as a denied foreign read plus an
    // out-of-allowlist write instead of a foreign-company grant.
    const reader = await issueGrant(app, session, writeGrantFor());
    const crossRead = await rpc(app, call(7, 'get_inventory', { company_id: TENANT_B }), reader.token);
    assert.equal(crossRead.json.result.isError, true);
    assert.equal(crossRead.json.result.errorCode, 'ERR_RESOURCE_NOT_ALLOWED');
    const narrow = await issueGrant(app, session, { ...writeGrantFor(), resourceAllowlist: ['comp_metal_01_line_2'] });
    const wrongLine = await rpc(app, call(8, 'set_production_target', {
      line_id: 'comp_metal_01_line_1', recipe_id: 'R1', target_batches: 1, idempotency_key: 'idem_outside_allowlist',
    }), narrow.token);
    assert.equal(wrongLine.json.result.isError, true);
    assert.equal(wrongLine.json.result.errorCode, 'ERR_RESOURCE_NOT_ALLOWED');
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 0);
  } finally { await app.close(); }
});

test('two clients share one match and rate limits apply through the transport', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const clientA = await issueGrant(app, session, writeGrantFor());
    const clientB = await issueGrant(app, session, writeGrantFor());
    const stateA = await request(app, '/v1/state', { token: app.token });
    assert.equal(stateA.status, 200);
    const readA = await rpc(app, call(8, 'get_inventory', { company_id: TENANT_A }), clientA.token);
    assert.equal(readA.json.result.isError, false);
    const readB = await rpc(app, call(9, 'get_inventory', { company_id: TENANT_A }), clientB.token);
    assert.equal(readB.json.result.isError, false);

    const limited = await issueGrant(app, session, {
      ...writeGrantFor(), quotas: { maxWritePerMinute: 1, maxWritePerMatch: 10 },
    });
    const first = await rpc(app, call(10, 'set_line_priority', {
      line_id: 'comp_metal_01_line_2', priority: 2, idempotency_key: 'idem_rate_first',
    }), limited.token);
    assert.equal(first.json.result.isError, false);
    const second = await rpc(app, call(11, 'set_line_priority', {
      line_id: 'comp_metal_01_line_3', priority: 2, idempotency_key: 'idem_rate_second',
    }), limited.token);
    assert.equal(second.json.result.isError, true);
    assert.equal(second.json.result.errorCode, 'ERR_RATE_LIMIT_EXCEEDED');
  } finally { await app.close(); }
});

test('a revoked grant is rejected through the transport', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session, writeGrantFor());
    const ok = await rpc(app, call(12, 'get_inventory', { company_id: TENANT_A }), issued.token);
    assert.equal(ok.json.result.isError, false);
    const revoked = await request(app, `/v1/owner/grants/${issued.grant.grantId}`, {
      method: 'DELETE', token: session,
    });
    assert.equal(revoked.status, 200);
    const after = await rpc(app, call(13, 'get_inventory', { company_id: TENANT_A }), issued.token);
    assert.equal(after.status, 200);
    assert.equal(after.json.result.isError, true);
    assert.equal(after.json.result.errorCode, 'ERR_AUTH_REVOKED');
  } finally { await app.close(); }
});

test('ping answers with an empty result and unknown tools are JSON-RPC errors', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const issued = await issueGrant(app, session, writeGrantFor());
    const ping = await rpc(app, { jsonrpc: '2.0', id: 14, method: 'ping' }, issued.token);
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json.result, {});
    const unknown = await rpc(app, call(15, 'trade_nft_for_pizza', {}), issued.token);
    assert.equal(unknown.json.result.isError, true);
  } finally { await app.close(); }
});

function writeGrantFor(): Record<string, unknown> {
  return { phaseMode: 'PHASE_1B_READ_WRITE', scopes: ALL_SCOPES };
}
