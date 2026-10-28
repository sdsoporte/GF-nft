import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { McpPhaseMode } from '../../src/mcp/types.ts';
import { createGatewayFixture, expectSuccess, makeGrant, TENANT_A, TENANT_B, LINE_A1, LINE_B1 } from './grant-helper.ts';

for (const phaseMode of ['PHASE_1_READ_ONLY', 'PHASE_1B_READ_WRITE'] as const satisfies readonly McpPhaseMode[]) {
  test(`${phaseMode}: history filters ownership before applying its limit`, async () => {
    const grant = makeGrant({ phaseMode });
    const { engine, gateway } = createGatewayFixture([grant]);
    const owners = [TENANT_A, TENANT_B, TENANT_A, TENANT_B];
    owners.forEach((companyId, index) => {
      engine.submitCommand({
        commandId: `cmd_history_${index}`, idempotencyKey: `idem_history_${index}`,
        companyId, scheduledTick: index + 1, type: 'PAUSE_PRODUCTION_LINE',
        lineId: index === 0 ? LINE_A1 : LINE_B1,
      });
      engine.processTick();
    });
    const all = engine.getExecutionHistory();
    assert.equal(all.length, 4);
    assert.deepEqual(all.map(result => result.companyId), owners);
    assert.equal(all[0].success, true);
    assert.equal(all[2].success, false);
    assert.equal(all[2].errorCode, 'ERR_LINE_NOT_FOUND');
    assert.deepEqual(engine.getExecutionHistory(1), [all[3]]);
    const before = engine.createSnapshot();
    const response = expectSuccess(await gateway.invokeTool(grant.token, 'get_action_history', { company_id: TENANT_A, last_n_ticks: 50 }));
    const history = (response.data as { history: Array<{ command_id: string; success: boolean; error_code?: string }> }).history;
    assert.deepEqual(history.map(result => result.command_id), ['cmd_history_0', 'cmd_history_2']);
    assert.deepEqual(history.map(result => result.success), [true, false]);
    assert.equal(history[1].error_code, 'ERR_LINE_NOT_FOUND');
    const limited = expectSuccess(await gateway.invokeTool(grant.token, 'get_action_history', { company_id: TENANT_A, last_n_ticks: 1 }));
    assert.deepEqual((limited.data as { history: Array<{ command_id: string }> }).history.map(result => result.command_id), ['cmd_history_2']);
    assert.deepEqual(engine.getCompanyExecutionHistory(TENANT_A, 1), [all[2]]);
    assert.deepEqual(engine.getExecutionHistory(), all);
    assert.deepEqual(engine.createSnapshot(), before);
    assert.equal(engine.getCommandQueue().getPendingCount(), 0);
  });

  test(`${phaseMode}: legacy results with unknown ownership remain private`, async () => {
    const grant = makeGrant({ phaseMode });
    const { engine, gateway } = createGatewayFixture([grant]);
    const legacy = { commandId: 'cmd_legacy_private', idempotencyKey: 'idem_legacy_private', executedAtTick: 1, success: true };
    engine.hydrate({ currentTick: 1, commandResults: [legacy] });
    const response = expectSuccess(await gateway.invokeTool(grant.token, 'get_action_history', { company_id: TENANT_A }));
    assert.deepEqual(response.data, { history: [] });
    assert.deepEqual(engine.getCompanyExecutionHistory(TENANT_A), []);
    assert.deepEqual(engine.getExecutionHistory(), [legacy]);
  });
}
