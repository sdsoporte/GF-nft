import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGatewayFixture, draftParams, expectError, expectSuccess, makeGrant, TENANT_A, TENANT_B } from './grant-helper.ts';

function economy(engine: ReturnType<typeof createGatewayFixture>['engine']) {
  return [TENANT_A, TENANT_B, 'comp_manuf_01', 'comp_manuf_02'].map(id => {
    const company = engine.getCompany(id)!;
    return structuredClone({ credits: company.credits, inventory: company.inventory });
  });
}

test('MCP drafts hold no funds, stay private and cannot be accepted or published by an agent', async () => {
  const author = makeGrant({ scopes: ['contracts:draft', 'market:read'] });
  const buyer = makeGrant({ companyId: TENANT_B });
  const { engine, gateway } = createGatewayFixture([author, buyer]);
  const before = economy(engine);
  expectSuccess(await gateway.invokeTool(author.token, 'draft_supply_offer', {
    ...draftParams('draft_nonbinding_001'), target_buyer_id: TENANT_B,
    type: 'PUBLISH_SUPPLY_OFFER', status: 'PENDING',
  }));
  engine.processTick();
  const draft = structuredClone(engine.getAllContracts()[0]);
  assert.equal(draft.status, 'DRAFT');
  assert.deepEqual(economy(engine), before);
  const quotes = expectSuccess(await gateway.invokeTool(buyer.token, 'get_market_quotes', {}));
  assert.deepEqual((quotes.data as { quotes: unknown[] }).quotes, []);
  const own = expectSuccess(await gateway.invokeTool(author.token, 'get_contracts', { company_id: TENANT_A, status: 'DRAFT' }));
  assert.equal((own.data as { contracts: unknown[] }).contracts.length, 1);
  const foreign = expectSuccess(await gateway.invokeTool(buyer.token, 'get_contracts', { company_id: TENANT_B }));
  assert.deepEqual((foreign.data as { contracts: unknown[] }).contracts, []);

  const pending = engine.getCommandQueue().getPendingCount();
  const sequence = engine.getCommandQueue().getSequenceCounter();
  expectError(await gateway.invokeTool(author.token, 'publish_supply_offer', {
    offer_id: draft.contractId, idempotency_key: 'agent_publish_denied',
  }), 'ERR_UNKNOWN_TOOL');
  assert.equal(engine.getCommandQueue().getPendingCount(), pending);
  assert.equal(engine.getCommandQueue().getSequenceCounter(), sequence);
  assert.equal(engine.submitCommand({ commandId: 'accept_unpublished', companyId: TENANT_B,
    scheduledTick: engine.getCurrentTick() + 1, idempotencyKey: 'accept_unpublished_001',
    type: 'ACCEPT_SUPPLY_OFFER', contractId: draft.contractId }), true);
  engine.processTick();
  assert.equal(engine.getExecutionHistory().at(-1)!.errorCode, 'ERR_OFFER_NOT_AVAILABLE');
  assert.deepEqual(engine.getContract(draft.contractId), draft);
  assert.deepEqual(economy(engine), before);
});

test('the five-draft limit survives same-tick enqueue and cancellation frees a slot without consuming an ID', async () => {
  const author = makeGrant();
  const { engine, gateway } = createGatewayFixture([author]);
  const before = economy(engine);
  for (let index = 0; index < 6; index++) {
    expectSuccess(await gateway.invokeTool(author.token, 'draft_supply_offer', draftParams(`draft_same_tick_${index}`)));
  }
  engine.processTick();
  const drafts = engine.getAllContracts();
  assert.equal(drafts.length, 5);
  assert.ok(drafts.every(draft => draft.status === 'DRAFT'));
  const rejected = engine.getExecutionHistory().filter(result => !result.success);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].errorCode, 'ERR_MAX_DRAFTS_REACHED');
  assert.equal(rejected[0].errorMessage, 'Maximum 5 open draft offers per company');
  assert.deepEqual(economy(engine), before);

  const pending = engine.getCommandQueue().getPendingCount();
  const sequence = engine.getCommandQueue().getSequenceCounter();
  expectError(await gateway.invokeTool(author.token, 'draft_supply_offer', draftParams('draft_over_limit_001')), 'ERR_MAX_DRAFTS_REACHED');
  assert.equal(engine.getCommandQueue().getPendingCount(), pending);
  assert.equal(engine.getCommandQueue().getSequenceCounter(), sequence);
  expectSuccess(await gateway.invokeTool(author.token, 'cancel_own_pending_offer', {
    offer_id: drafts[0].contractId, idempotency_key: 'draft_cancel_own_001',
  }));
  engine.processTick();
  assert.equal(engine.getContract(drafts[0].contractId)!.status, 'CANCELLED');
  assert.equal(engine.getExecutionHistory().at(-1)!.success, true);
  expectSuccess(await gateway.invokeTool(author.token, 'draft_supply_offer', draftParams('draft_replacement_001')));
  engine.processTick();
  assert.equal(engine.getAllContracts().filter(draft => draft.status === 'DRAFT').length, 5);
  assert.ok(engine.getContract(`cnt_${engine.getCurrentTick()}_6`));
  assert.deepEqual(economy(engine), before);
  const audit = gateway.getAuditLogs();
  assert.equal(audit.filter(log => log.toolName === 'draft_supply_offer').length, 8);
  assert.ok(audit.some(log => log.toolName === 'draft_supply_offer' && log.resultCode === 'ERR_MAX_DRAFTS_REACHED'));
  assert.ok(audit.some(log => log.toolName === 'cancel_own_pending_offer' && log.resultCode === 'SUCCESS'));
  assert.ok(audit.every(log => log.companyId === TENANT_A));
});

test('publication revalidates ownership, future deadline and collateral without changing a rejected draft', async () => {
  for (const scenario of ['foreign', 'expired', 'underfunded'] as const) {
    const author = makeGrant();
    const { engine, gateway } = createGatewayFixture([author]);
    if (scenario === 'underfunded') engine.getCompany(TENANT_A)!.credits = 0;
    expectSuccess(await gateway.invokeTool(author.token, 'draft_supply_offer', draftParams(`draft_guard_${scenario}`)));
    engine.processTick();
    const draft = structuredClone(engine.getAllContracts()[0]);
    assert.equal(draft.status, 'DRAFT');
    if (scenario === 'expired') {
      while (engine.getCurrentTick() < draft.deadlineTick) engine.processTick();
    }
    const before = economy(engine);
    const history = engine.getExecutionHistory().length;
    assert.equal(engine.submitCommand({ commandId: `publish_${scenario}`, companyId: scenario === 'foreign' ? TENANT_B : TENANT_A,
      scheduledTick: engine.getCurrentTick() + 1, idempotencyKey: `publish_guard_${scenario}`,
      type: 'PUBLISH_SUPPLY_OFFER', contractId: draft.contractId }), true);
    engine.processTick();
    const result = engine.getExecutionHistory().at(-1)!;
    assert.equal(result.success, false);
    assert.equal(result.errorCode, scenario === 'foreign' ? 'ERR_CANNOT_PUBLISH'
      : scenario === 'expired' ? 'ERR_INVALID_OFFER_PARAMS' : 'ERR_INSUFFICIENT_COLLATERAL');
    assert.equal(result.errorMessage, scenario === 'foreign' ? 'Only draft offers owned by the company can be published'
      : scenario === 'expired' ? 'Offer deadline must be in the future'
      : `Seller requires ${draft.collateralSellerCredits} CREDITS collateral (20%)`);
    assert.deepEqual(engine.getContract(draft.contractId), draft);
    assert.deepEqual(economy(engine), before);
    assert.equal(engine.getExecutionHistory().length, history + 1);
  }
});
