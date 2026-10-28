import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { McpGateway } from '../../src/mcp/McpGateway.ts';
import type { McpPhaseMode, McpReadToolName, McpScope } from '../../src/mcp/types.ts';
import {
  TENANT_A, TENANT_B, TENANT_ABSENT, createGatewayFixture, makeGrant,
  expectError, expectSuccess, pendingCommandCount,
} from './grant-helper.ts';

const READS: readonly [McpReadToolName, McpScope][] = [
  ['get_factory_overview', 'factory:read'], ['get_inventory', 'inventory:read'],
  ['get_production_lines', 'factory:read'], ['get_contracts', 'market:read'],
  ['get_action_history', 'factory:read'], ['get_market_quotes', 'market:read'],
];
const MODES: readonly McpPhaseMode[] = ['PHASE_1_READ_ONLY', 'PHASE_1B_READ_WRITE'];
const params = (tool: McpReadToolName, companyId = TENANT_A) =>
  tool === 'get_market_quotes' ? {} : { company_id: companyId };

for (const phaseMode of MODES) {
  describe(`tenant read authorization: ${phaseMode}`, () => {
    for (const [tool, scope] of READS) {
      test(`${tool} retains own-company/public read behavior`, async () => {
        const grant = makeGrant({ phaseMode });
        const { gateway, engine } = createGatewayFixture([grant]);
        const before = engine.createSnapshot();
        const response = expectSuccess(await gateway.invokeTool(grant.token, tool, params(tool)));
        assert.equal(response.tool, tool);
        assert.equal(response.tick, engine.getCurrentTick());
        assert.deepEqual(engine.createSnapshot(), before);
        assert.equal(pendingCommandCount(engine), 0);
        assert.equal(gateway.getAuditLogs().at(-1)!.resultCode, 'SUCCESS');
      });

      test(`${tool} checks ${scope} independently of grant phase`, async () => {
        const grant = makeGrant({ phaseMode, scopes: [], quotas: { maxReadPerMinute: 1 } });
        const { gateway, engine } = createGatewayFixture([grant]);
        const before = engine.createSnapshot();
        const response = expectError(await gateway.invokeTool(grant.token, tool, params(tool)), 'ERR_SCOPE_UNAUTHORIZED');
        assert.equal(response.errorMessage, `Missing required scope: ${scope}`);
        assert.equal('data' in response, false);
        assert.deepEqual(engine.createSnapshot(), before);
        assert.equal(pendingCommandCount(engine), 0);
        assert.equal(gateway.getAuditLogs().length, 1);
        assert.equal(gateway.getAuditLogs()[0].resultCode, 'ERR_SCOPE_UNAUTHORIZED');
      });

      if (tool !== 'get_market_quotes') {
        test(`${tool} denies a foreign company without consuming read quota`, async () => {
          const grant = makeGrant({ phaseMode, quotas: { maxReadPerMinute: 1 } });
          const { gateway, engine } = createGatewayFixture([grant]);
          const before = engine.createSnapshot();
          const response = expectError(await gateway.invokeTool(grant.token, tool, params(tool, TENANT_B)), 'ERR_RESOURCE_NOT_ALLOWED');
          assert.equal(response.errorMessage, 'Requested company is not authorized by this grant');
          assert.equal('data' in response, false);
          assert.deepEqual(engine.createSnapshot(), before);
          assert.equal(pendingCommandCount(engine), 0);
          assert.equal(gateway.getAuditLogs().length, 1);
          assert.equal(gateway.getAuditLogs()[0].companyId, TENANT_A);
          assert.equal(gateway.getAuditLogs()[0].resultCode, 'ERR_RESOURCE_NOT_ALLOWED');
          expectSuccess(await gateway.invokeTool(grant.token, tool, params(tool)));
          expectError(await gateway.invokeTool(grant.token, tool, params(tool)), 'ERR_RATE_LIMIT_EXCEEDED');
        });
      }

      for (const [binding, overrides] of [
        ['match', { matchId: 'match_foreign' }],
        ['player', { playerId: 'player_foreign' }],
        ['company', { companyId: TENANT_ABSENT }],
      ] as const) {
        test(`${tool} rejects an invalid ${binding} binding`, async () => {
          const grant = { ...makeGrant({ phaseMode }), ...overrides };
          const { gateway, engine } = createGatewayFixture([grant]);
          const before = engine.createSnapshot();
          const response = expectError(await gateway.invokeTool(grant.token, tool, params(tool, grant.companyId)), 'ERR_RESOURCE_NOT_ALLOWED');
          assert.equal(response.errorMessage, 'Grant identity is not authorized for this match and company');
          assert.equal('data' in response, false);
          assert.deepEqual(engine.createSnapshot(), before);
          assert.equal(pendingCommandCount(engine), 0);
          assert.equal(gateway.getAuditLogs().length, 1);
          assert.equal(gateway.getAuditLogs()[0].resultCode, 'ERR_RESOURCE_NOT_ALLOWED');
        });
      }
    }
  });
}

test('a gateway without server identity bindings fails closed', async () => {
  const grant = makeGrant();
  const { engine } = createGatewayFixture();
  const gateway = new McpGateway(engine);
  gateway.registerGrant(grant);
  expectError(await gateway.invokeTool(grant.token, 'get_inventory', params('get_inventory')), 'ERR_RESOURCE_NOT_ALLOWED');
  assert.equal(pendingCommandCount(engine), 0);
});

test('public market quotes preserve visibility of another company pending offers', async () => {
  const grant = makeGrant();
  const { engine, gateway } = createGatewayFixture([grant]);
  engine.submitCommand({
    commandId: 'cmd_public_quote', companyId: TENANT_B, scheduledTick: 1,
    idempotencyKey: 'idem_public_quote', type: 'CREATE_SUPPLY_OFFER',
    itemId: 'STEEL_PLATE', quantity: 10, unitPriceCredits: 10, deadlineTicks: 100,
  });
  engine.processTick();
  const result = expectSuccess(await gateway.invokeTool(grant.token, 'get_market_quotes', {}));
  const { quotes } = result.data as { quotes: Array<Record<string, unknown>> };
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].seller_company_id, TENANT_B.toUpperCase());
  assert.deepEqual(Object.keys(quotes[0]).sort(), [
    'deadline_tick', 'item_id', 'offer_id', 'quantity', 'seller_company_id',
    'total_value_credits', 'unit_price_credits',
  ]);
});
