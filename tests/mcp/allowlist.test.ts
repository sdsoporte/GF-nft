/**
 * S4 (issue #10): resource allowlist and line-cooldown enforcement.
 *
 * The allowlist is the gateway's second authorization layer after scopes: a
 * grant may hold `production:write` and still be limited to the production
 * lines it was provisioned for. Cooldowns protect the engine from write storms
 * on the same line.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LINE_A1,
  LINE_A2,
  LINE_B1,
  TENANT_A,
  createGatewayFixture,
  expectError,
  expectSuccess,
  makeGrant,
  overviewParams,
  pendingCommandCount,
  targetParams,
} from './grant-helper.ts';

describe('resource allowlist', () => {
  test('a line outside the allowlist is rejected and nothing is enqueued', async () => {
    const grant = makeGrant({ resourceAllowlist: [LINE_A1] });
    const { gateway, engine } = createGatewayFixture([grant]);

    const failure = expectError(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A2, 'idem_allow_denied')),
      'ERR_INVALID_PAYLOAD'
    );
    assert.match(failure.errorMessage, /ERR_RESOURCE_NOT_ALLOWED/);
    assert.equal(pendingCommandCount(engine), 0);
  });

  test('an allowlisted line is accepted and queued for the next tick', async () => {
    const grant = makeGrant({ resourceAllowlist: [LINE_A1] });
    const { gateway, engine } = createGatewayFixture([grant]);

    const data = expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_allow_ok'))
    ).data as { status: string; scheduled_tick: number; line_id: string };

    assert.equal(data.status, 'ENQUEUED_FOR_NEXT_TICK');
    assert.equal(data.scheduled_tick, 1);
    assert.equal(data.line_id, LINE_A1);
    assert.equal(pendingCommandCount(engine), 1);
  });

  test('every line-targeting write tool honours the allowlist', async () => {
    const grant = makeGrant({ resourceAllowlist: [] });
    const { gateway, engine } = createGatewayFixture([grant]);

    const calls: Array<[string, Record<string, unknown>]> = [
      ['set_production_target', targetParams(LINE_A1, 'idem_allow_all_1')],
      ['set_line_priority', { line_id: LINE_A1, priority: 2, idempotency_key: 'idem_allow_all_2' }],
      ['pause_production_line', { line_id: LINE_A1, idempotency_key: 'idem_allow_all_3' }],
      ['resume_production_line', { line_id: LINE_A1, idempotency_key: 'idem_allow_all_4' }],
    ];

    for (const [tool, params] of calls) {
      const failure = expectError(await gateway.invokeTool(grant.token, tool, params), 'ERR_INVALID_PAYLOAD');
      assert.match(failure.errorMessage, /ERR_RESOURCE_NOT_ALLOWED/, `${tool} skipped the allowlist`);
    }
    assert.equal(pendingCommandCount(engine), 0);
  });

  test('the allowlist is per grant, not per company', async () => {
    const first = makeGrant({
      grantId: 'grant_allow_first',
      token: 'gf_mcp_token_allow_01',
      resourceAllowlist: [LINE_A1],
    });
    const second = makeGrant({
      grantId: 'grant_allow_second',
      token: 'gf_mcp_token_allow_02',
      resourceAllowlist: [LINE_A2],
    });
    const { gateway } = createGatewayFixture([first, second]);

    expectSuccess(await gateway.invokeTool(first.token, 'set_line_priority', {
      line_id: LINE_A1,
      priority: 2,
      idempotency_key: 'idem_allow_scope_1',
    }));
    expectError(
      await gateway.invokeTool(first.token, 'set_line_priority', {
        line_id: LINE_A2,
        priority: 2,
        idempotency_key: 'idem_allow_scope_2',
      }),
      'ERR_INVALID_PAYLOAD'
    );
    expectSuccess(await gateway.invokeTool(second.token, 'set_line_priority', {
      line_id: LINE_A2,
      priority: 2,
      idempotency_key: 'idem_allow_scope_3',
    }));
  });

  test('a line of another company is only reachable through the engine ownership check', async () => {
    // The gateway allowlist is a plain string list, so a misprovisioned grant
    // can name a foreign line; the engine then refuses it (see isolation.test.ts).
    const grant = makeGrant({ resourceAllowlist: [LINE_B1] });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_B1, 'idem_allow_foreign'))
    );
  });

  test('read tools are not line-scoped and ignore the allowlist', async () => {
    const grant = makeGrant({ resourceAllowlist: [] });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(await gateway.invokeTool(grant.token, 'get_production_lines', overviewParams(TENANT_A)));
  });
});

describe('line cooldowns', () => {
  test('a repeated write on the same line inside the cooldown window is rejected', async () => {
    const grant = makeGrant({ resourceAllowlist: [LINE_A1] });
    const { gateway, engine } = createGatewayFixture([grant]);

    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_cooldown_1'))
    );

    const failure = expectError(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_cooldown_2')),
      'ERR_INVALID_PAYLOAD'
    );
    assert.match(failure.errorMessage, /ERR_COOLDOWN_ACTIVE/);
    assert.equal(pendingCommandCount(engine), 1);

    // SET_PRODUCTION_TARGET cools down for 5 ticks.
    for (let tick = 0; tick < 5; tick += 1) {
      engine.processTick();
    }
    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_cooldown_3'))
    );
  });

  test('cooldowns are keyed per tool, so a different action on the same line is allowed', async () => {
    const grant = makeGrant({ resourceAllowlist: [LINE_A1] });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_cooldown_tool_1'))
    );
    expectSuccess(
      await gateway.invokeTool(grant.token, 'pause_production_line', {
        line_id: LINE_A1,
        idempotency_key: 'idem_cooldown_tool_2',
      })
    );
  });

  test('cooldowns are keyed per line, so the same action on another line is allowed', async () => {
    const grant = makeGrant({ resourceAllowlist: [LINE_A1, LINE_A2] });
    const { gateway } = createGatewayFixture([grant]);

    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_line_priority', {
        line_id: LINE_A1,
        priority: 2,
        idempotency_key: 'idem_cooldown_line_1',
      })
    );
    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_line_priority', {
        line_id: LINE_A2,
        priority: 3,
        idempotency_key: 'idem_cooldown_line_2',
      })
    );
  });
});
