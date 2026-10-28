/**
 * S4 (issue #10): grant lifecycle security — expiry, revocation, scopes,
 * phase mode, quotas and the audit trail of denials.
 *
 * All assertions describe behaviour that already exists in
 * `src/mcp/McpGateway.ts`; the gateway is exercised only through its public
 * surface (`registerGrant`, `revokeGrant`, `setGrantPhaseMode`, `invokeTool`,
 * `getAuditLogs`).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  EXPIRED_IN_PAST,
  LINE_A1,
  LINE_A2,
  TENANT_A,
  createGatewayFixture,
  expectError,
  expectSuccess,
  makeGrant,
  overviewParams,
  pendingCommandCount,
  targetParams,
} from './grant-helper.ts';

describe('grant expiry', () => {
  test('a grant whose expiry is in the past is rejected with ERR_AUTH_EXPIRED', async () => {
    const grant = makeGrant({ expiresAtUtc: EXPIRED_IN_PAST });
    const { gateway } = createGatewayFixture([grant]);

    const response = await gateway.invokeTool(grant.token, 'get_factory_overview', overviewParams(TENANT_A));

    const failure = expectError(response, 'ERR_AUTH_EXPIRED');
    assert.match(failure.errorMessage, /expired/i);
    assert.equal('data' in failure, false, 'a rejected call must not return company data');
  });

  test('expiry is enforced for write tools too, before scope and phase checks', async () => {
    const grant = makeGrant({
      expiresAtUtc: EXPIRED_IN_PAST,
      scopes: [],
      phaseMode: 'PHASE_1_READ_ONLY',
    });
    const { gateway, engine } = createGatewayFixture([grant]);

    const response = await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_expired_write'));

    expectError(response, 'ERR_AUTH_EXPIRED');
    assert.equal(pendingCommandCount(engine), 0, 'an expired grant must never enqueue a command');
  });

  test('a grant with a future expiry is accepted', async () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);

    const response = await gateway.invokeTool(grant.token, 'get_factory_overview', overviewParams(TENANT_A));

    const data = expectSuccess(response).data as { company_id: string; current_tick: number };
    assert.equal(data.current_tick, 0);
    assert.equal(data.company_id, TENANT_A.toUpperCase());
  });
});

describe('grant revocation (emergency disconnect)', () => {
  test('revokeGrant reports whether the grant existed and is idempotent', () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);

    assert.equal(gateway.revokeGrant('grant_unknown_77'), false);
    assert.equal(gateway.revokeGrant(grant.grantId), true);
    assert.equal(gateway.revokeGrant(grant.grantId), true);
    assert.equal(gateway.getGrant(grant.grantId)?.revoked, true);
  });

  test('a revoked grant is rejected for read tools with ERR_AUTH_REVOKED', async () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);
    gateway.revokeGrant(grant.grantId);

    const response = await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A));

    const failure = expectError(response, 'ERR_AUTH_REVOKED');
    assert.match(failure.errorMessage, /revoked/i);
  });

  test('a revoked grant is rejected for write tools and enqueues nothing', async () => {
    const grant = makeGrant();
    const { gateway, engine } = createGatewayFixture([grant]);
    gateway.revokeGrant(grant.grantId);

    const response = await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_revoked_write'));

    expectError(response, 'ERR_AUTH_REVOKED');
    assert.equal(pendingCommandCount(engine), 0);
  });

  test('revocation wins over expiry when a grant is both expired and revoked', async () => {
    const grant = makeGrant({ expiresAtUtc: EXPIRED_IN_PAST });
    const { gateway } = createGatewayFixture([grant]);
    gateway.revokeGrant(grant.grantId);

    const response = await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A));

    expectError(response, 'ERR_AUTH_REVOKED');
  });

  test('revocation is per grant: a sibling token of the same company keeps working', async () => {
    const primary = makeGrant({ grantId: 'grant_a_primary', token: 'gf_mcp_token_primary_01' });
    const agent = makeGrant({ grantId: 'grant_a_agent', token: 'gf_mcp_token_agent_01' });
    const { gateway } = createGatewayFixture([primary, agent]);

    gateway.revokeGrant(primary.grantId);

    expectError(
      await gateway.invokeTool(primary.token, 'get_inventory', overviewParams(TENANT_A)),
      'ERR_AUTH_REVOKED'
    );
    expectSuccess(await gateway.invokeTool(agent.token, 'get_inventory', overviewParams(TENANT_A)));
  });
});

describe('scope verification', () => {
  test('a tool call without its required scope is rejected with ERR_SCOPE_UNAUTHORIZED', async () => {
    const grant = makeGrant({ scopes: ['inventory:read'] });
    const { gateway } = createGatewayFixture([grant]);

    const failure = expectError(
      await gateway.invokeTool(grant.token, 'get_factory_overview', overviewParams(TENANT_A)),
      'ERR_SCOPE_UNAUTHORIZED'
    );
    assert.match(failure.errorMessage, /factory:read/);

    // The scope the grant does hold still works.
    expectSuccess(await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A)));
  });

  test('a grant with no scopes cannot reach any tool', async () => {
    const grant = makeGrant({ scopes: [] });
    const { gateway } = createGatewayFixture([grant]);

    for (const tool of ['get_factory_overview', 'get_inventory', 'get_market_quotes'] as const) {
      expectError(
        await gateway.invokeTool(grant.token, tool, overviewParams(TENANT_A)),
        'ERR_SCOPE_UNAUTHORIZED'
      );
    }
  });

  test('write scopes are distinct: contracts:draft alone cannot drive production', async () => {
    const grant = makeGrant({ scopes: ['contracts:draft'] });
    const { gateway, engine } = createGatewayFixture([grant]);

    expectError(
      await gateway.invokeTool(grant.token, 'set_line_priority', {
        line_id: LINE_A1,
        priority: 2,
        idempotency_key: 'idem_scope_priority',
      }),
      'ERR_SCOPE_UNAUTHORIZED'
    );
    assert.equal(pendingCommandCount(engine), 0);
  });
});

describe('phase mode policy', () => {
  test('write tools are blocked in PHASE_1_READ_ONLY', async () => {
    const grant = makeGrant({ phaseMode: 'PHASE_1_READ_ONLY' });
    const { gateway, engine } = createGatewayFixture([grant]);

    const failure = expectError(
      await gateway.invokeTool(grant.token, 'pause_production_line', {
        line_id: LINE_A1,
        idempotency_key: 'idem_phase1_pause',
      }),
      'ERR_SCOPE_DISABLED_IN_PHASE_1'
    );
    assert.match(failure.errorMessage, /Phase 1/i);
    assert.equal(pendingCommandCount(engine), 0);
  });

  test('read tools keep working in PHASE_1_READ_ONLY', async () => {
    const grant = makeGrant({ phaseMode: 'PHASE_1_READ_ONLY' });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(await gateway.invokeTool(grant.token, 'get_production_lines', overviewParams(TENANT_A)));
  });

  test('switching a grant to PHASE_1B enables write tools', async () => {
    const grant = makeGrant({ phaseMode: 'PHASE_1_READ_ONLY' });
    const { gateway, engine } = createGatewayFixture([grant]);

    expectError(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_phase_switch')),
      'ERR_SCOPE_DISABLED_IN_PHASE_1'
    );

    assert.equal(gateway.setGrantPhaseMode(grant.grantId, 'PHASE_1B_READ_WRITE'), true);
    assert.equal(gateway.setGrantPhaseMode('grant_unknown_77', 'PHASE_1B_READ_WRITE'), false);

    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_phase_switch'))
    );
    assert.equal(pendingCommandCount(engine), 1);
  });
});

describe('rate limits and quotas', () => {
  test('read quota rejects the call above maxReadPerMinute', async () => {
    const grant = makeGrant({ quotas: { maxReadPerMinute: 2 } });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A)));
    expectSuccess(await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A)));
    const failure = expectError(
      await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A)),
      'ERR_RATE_LIMIT_EXCEEDED'
    );
    assert.match(failure.errorMessage, /2\/min/);
  });

  test('write quota rejects the call above maxWritePerMinute', async () => {
    const grant = makeGrant({ quotas: { maxWritePerMinute: 1 } });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_write_quota_1')));
    expectError(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A2, 'idem_write_quota_2')),
      'ERR_RATE_LIMIT_EXCEEDED'
    );
  });

  test('match write quota caps total writes below the per-minute quota', async () => {
    const grant = makeGrant({ quotas: { maxWritePerMinute: 50, maxWritePerMatch: 2 } });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_match_quota_1')));
    expectSuccess(await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A2, 'idem_match_quota_2')));
    const failure = expectError(
      await gateway.invokeTool(grant.token, 'set_line_priority', {
        line_id: LINE_A1,
        priority: 2,
        idempotency_key: 'idem_match_quota_3',
      }),
      'ERR_RATE_LIMIT_EXCEEDED'
    );
    assert.match(failure.errorMessage, /Match write quota/);
  });

  test('quotas are tracked per grant, not per company', async () => {
    const exhausted = makeGrant({ grantId: 'grant_quota_exhausted', token: 'gf_mcp_token_quota_01', quotas: { maxReadPerMinute: 1 } });
    const fresh = makeGrant({ grantId: 'grant_quota_fresh', token: 'gf_mcp_token_quota_02', quotas: { maxReadPerMinute: 1 } });
    const { gateway } = createGatewayFixture([exhausted, fresh]);

    expectSuccess(await gateway.invokeTool(exhausted.token, 'get_inventory', overviewParams(TENANT_A)));
    expectError(
      await gateway.invokeTool(exhausted.token, 'get_inventory', overviewParams(TENANT_A)),
      'ERR_RATE_LIMIT_EXCEEDED'
    );
    expectSuccess(await gateway.invokeTool(fresh.token, 'get_inventory', overviewParams(TENANT_A)));
  });
});

describe('audit trail of denials', () => {
  test('revoked calls are audited against the grant and company', async () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);
    gateway.revokeGrant(grant.grantId);

    await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A));

    const last = gateway.getAuditLogs(1)[0];
    assert.equal(last.grantId, grant.grantId);
    assert.equal(last.companyId, TENANT_A);
    assert.equal(last.toolName, 'get_inventory');
    assert.equal(last.resultCode, 'ERR_AUTH_REVOKED');
    assert.match(last.payloadHash, /^[0-9a-f]{8}$/);
  });

  test('unauthenticated calls are audited without granting identity to the caller', async () => {
    const { gateway } = createGatewayFixture([]);

    await gateway.invokeTool('gf_mcp_unknown_token', 'get_factory_overview', overviewParams(TENANT_A));

    const last = gateway.getAuditLogs(1)[0];
    assert.equal(last.resultCode, 'ERR_AUTH_INVALID');
    assert.equal(last.grantId, 'unknown');
    assert.equal(last.companyId, 'unknown');
  });

  test('the audit log never stores the bearer token or the raw payload text', async () => {
    const grant = makeGrant({ scopes: [] });
    const { gateway } = createGatewayFixture([grant]);

    await gateway.invokeTool(grant.token, 'get_factory_overview', {
      company_id: 'IGNORE_PREVIOUS_INSTRUCTIONS',
    });

    const serialized = JSON.stringify(gateway.getAuditLogs());
    assert.equal(serialized.includes(grant.token), false, 'audit log leaked the bearer token');
    assert.equal(serialized.includes('IGNORE_PREVIOUS_INSTRUCTIONS'), false, 'audit log leaked raw payload text');
  });

  test('getAuditLogs(limit) returns only the newest entries', async () => {
    const grant = makeGrant({ quotas: { maxReadPerMinute: 1 } });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A)));
    expectError(
      await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_A)),
      'ERR_RATE_LIMIT_EXCEEDED'
    );

    assert.equal(gateway.getAuditLogs().length, 2);
    const newest = gateway.getAuditLogs(1);
    assert.equal(newest.length, 1);
    assert.equal(newest[0].resultCode, 'ERR_RATE_LIMIT_EXCEEDED');
  });
});
