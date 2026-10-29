/**
 * Cross-tenant regression contracts: private reads and engine-enforced writes
 * are asserted. Only the retained legacy grant re-registration case is skipped.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  LINE_A1,
  LINE_B1,
  TENANT_A,
  TENANT_B,
  createGatewayFixture,
  draftParams,
  expectError,
  expectSuccess,
  makeGrant,
  overviewParams,
  targetParams,
} from './grant-helper.ts';

const SELLER_B = makeGrant({ companyId: TENANT_B });

/** Trusted manual engine command; MCP grants cannot invoke this publication. */
function publishFixtureOffer(engine: ReturnType<typeof createGatewayFixture>['engine'], companyId: string,
  contractId: string, idempotencyKey: string): void {
  assert.equal(engine.submitCommand({
    commandId: `human_${idempotencyKey}`, companyId, contractId, idempotencyKey,
    scheduledTick: engine.getCurrentTick() + 1, type: 'PUBLISH_SUPPLY_OFFER',
  }), true);
  engine.processTick();
  assert.equal(engine.getExecutionHistory().at(-1)!.success, true);
  assert.equal(engine.getContract(contractId)!.status, 'PENDING');
}

describe('isolation enforced today (write path)', () => {
  test('a write cannot reach a production line owned by another company', async () => {
    // Provisioning error on purpose: the allowlist names a foreign line.
    const grant = makeGrant({ resourceAllowlist: [LINE_B1] });
    const { gateway, engine } = createGatewayFixture([grant]);

    // The gateway only queues; the engine owns company/line binding.
    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_B1, 'idem_iso_foreign_line'))
    );
    engine.processTick();

    const last = engine.getExecutionHistory().at(-1)!;
    assert.equal(last.success, false);
    assert.equal(last.errorCode, 'ERR_LINE_NOT_FOUND');

    assert.equal(engine.getCompany(TENANT_A)!.lines[0].status, 'IDLE');
    assert.equal(engine.getCompany(TENANT_B)!.lines[0].status, 'IDLE');
  });

  test('a set_production_target on a busy line is engine-rejected and audited (issue #48)', async () => {
    const grant = makeGrant({ resourceAllowlist: [LINE_A1] });
    const { gateway, engine } = createGatewayFixture([grant]);

    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_busy_first'))
    );
    engine.processTick();
    const line = engine.getCompany(TENANT_A)!.lines[0];
    assert.ok(line.activeBatch, 'the first MCP command must start a batch');

    // The gateway's per-line write cooldown must lapse before the re-target
    // reaches the queue; the batch stays active while it does.
    for (let tick = 0; tick < 6; tick += 1) {
      engine.processTick();
    }
    assert.ok(line.activeBatch, 'the in-flight batch must still be running');

    const auditBefore = gateway.getAuditLogs().length;
    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', targetParams(LINE_A1, 'idem_busy_second'))
    );
    engine.processTick();

    const last = engine.getExecutionHistory().at(-1)!;
    assert.equal(last.success, false);
    assert.equal(last.errorCode, 'ERR_LINE_BUSY');
    // The in-flight batch survives the rejected re-target.
    assert.equal(line.activeBatch!.recipeId, 'R1');
    assert.equal(engine.getCompany(TENANT_B)!.lines[0].activeBatch, null);
    // Exactly the new call was audited, attributed to the grant company.
    assert.equal(gateway.getAuditLogs().length, auditBefore + 1);
    assert.equal(gateway.getAuditLogs().at(-1)!.companyId, TENANT_A);
  });

  test('a write command is attributed to the grant company, never to a payload field', async () => {
    const grant = makeGrant({ resourceAllowlist: [LINE_A1] });
    const { gateway, engine } = createGatewayFixture([grant]);

    expectSuccess(
      await gateway.invokeTool(grant.token, 'set_production_target', {
        ...targetParams(LINE_A1, 'idem_iso_attribution'),
        company_id: TENANT_B,
      })
    );
    engine.processTick();

    const ownLine = engine.getCompany(TENANT_A)!.lines[0];
    assert.equal(ownLine.status, 'RUNNING');
    assert.equal(engine.getCompany(TENANT_B)!.lines[0].status, 'IDLE');
  });

  test('one tenant cannot cancel another tenant pending offer', async () => {
    const attacker = makeGrant({ grantId: 'grant_a_attacker', token: 'gf_mcp_token_a_attacker' });
    const { gateway, engine } = createGatewayFixture([SELLER_B, attacker]);

    expectSuccess(
      await gateway.invokeTool(SELLER_B.token, 'draft_supply_offer', draftParams('idem_iso_draft_cancel'))
    );
    engine.processTick();
    const offer = engine.getAllContracts()[0];
    assert.equal(offer.sellerCompanyId, TENANT_B);
    assert.equal(offer.status, 'DRAFT');

    for (const status of ['DRAFT', 'PENDING'] as const) {
      if (status === 'PENDING') {
        publishFixtureOffer(engine, TENANT_B, offer.contractId, 'human_iso_publish_cancel');
      }
      const before = structuredClone(engine.getContract(offer.contractId));
      expectSuccess(await gateway.invokeTool(attacker.token, 'cancel_own_pending_offer', {
        offer_id: offer.contractId, idempotency_key: `idem_iso_cancel_foreign_${status}`,
      }));
      engine.processTick();
      const last = engine.getExecutionHistory().at(-1)!;
      assert.equal(last.success, false);
      assert.equal(last.errorCode, 'ERR_CANNOT_CANCEL');
      assert.equal(last.errorMessage, 'Only draft or pending offers owned by the company can be cancelled');
      assert.deepEqual(engine.getContract(offer.contractId), before);
    }
  });

  test('a buyer cannot dispatch goods for a contract it does not sell', async () => {
    const seller = makeGrant({ resourceAllowlist: [LINE_A1] });
    const buyer = makeGrant({
      companyId: TENANT_B,
      grantId: 'grant_b_buyer',
      token: 'gf_mcp_token_b_buyer',
    });
    const { gateway, engine } = createGatewayFixture([seller, buyer]);

    expectSuccess(await gateway.invokeTool(seller.token, 'draft_supply_offer', draftParams('idem_iso_draft_dispatch')));
    engine.processTick();
    const offer = engine.getAllContracts()[0];

    publishFixtureOffer(engine, TENANT_A, offer.contractId, 'human_iso_publish_dispatch');

    // Buyer side acceptance is not part of the MCP catalogue; the engine command
    // is the public surface for it.
    engine.submitCommand({
      commandId: 'cmd_iso_accept',
      companyId: TENANT_B,
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: 'idem_iso_accept',
      type: 'ACCEPT_SUPPLY_OFFER',
      contractId: offer.contractId,
    });
    engine.processTick();
    assert.equal(engine.getContract(offer.contractId)!.status, 'ACTIVE');

    expectSuccess(
      await gateway.invokeTool(buyer.token, 'schedule_internal_transport', {
        contract_id: offer.contractId,
        quantity_to_ship: 1,
        idempotency_key: 'idem_iso_dispatch_buyer',
      })
    );
    engine.processTick();

    const last = engine.getExecutionHistory().at(-1)!;
    assert.equal(last.success, false);
    assert.equal(last.errorCode, 'ERR_UNAUTHORIZED_DISPATCH');
    assert.equal(engine.getContract(offer.contractId)!.deliveredQuantity, 0);
  });
});

describe('cross-tenant reads — issue #2 regression', () => {

  test('get_factory_overview rejects a company_id that is not the grant company', async () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);

    const response = await gateway.invokeTool(grant.token, 'get_factory_overview', overviewParams(TENANT_B));

    expectError(response, 'ERR_RESOURCE_NOT_ALLOWED');
  });

  test('get_inventory rejects a company_id that is not the grant company', async () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);

    const response = await gateway.invokeTool(grant.token, 'get_inventory', overviewParams(TENANT_B));

    expectError(response, 'ERR_RESOURCE_NOT_ALLOWED');
  });

  test('get_production_lines rejects a company_id that is not the grant company', async () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);

    const response = await gateway.invokeTool(grant.token, 'get_production_lines', overviewParams(TENANT_B));

    expectError(response, 'ERR_RESOURCE_NOT_ALLOWED');
  });

  test('get_contracts rejects a company_id that is not the grant company', async () => {
    const grant = makeGrant();
    const { gateway } = createGatewayFixture([grant]);

    const response = await gateway.invokeTool(grant.token, 'get_contracts', overviewParams(TENANT_B));

    expectError(response, 'ERR_RESOURCE_NOT_ALLOWED');
  });

  test('get_action_history is scoped to the grant company', async () => {
    const grant = makeGrant();
    const seller = makeGrant({
      companyId: TENANT_B,
      grantId: 'grant_b_history',
      token: 'gf_mcp_token_b_history',
    });
    const { gateway, engine } = createGatewayFixture([grant, seller]);

    await gateway.invokeTool(seller.token, 'draft_supply_offer', draftParams('idem_iso_history_b'));
    engine.processTick();

    const response = await gateway.invokeTool(grant.token, 'get_action_history', {
      company_id: TENANT_A,
      last_n_ticks: 50,
    });
    const data = expectSuccess(response).data as {
      history: Array<{ command_id: string; idempotency_key: string }>;
    };

    assert.deepEqual(data.history, []);
  });
});

describe('pending P0 defects adjacent to tenant isolation', () => {
  test('drafts are not published to the market before an explicit publish step', async () => {
    const author = makeGrant({ companyId: TENANT_A });
    const observer = makeGrant({
      companyId: TENANT_B,
      grantId: 'grant_b_observer',
      token: 'gf_mcp_token_b_observer',
    });
    const { gateway, engine } = createGatewayFixture([author, observer]);

    await gateway.invokeTool(author.token, 'draft_supply_offer', draftParams('idem_iso_draft_publish'));
    engine.processTick();

    const response = await gateway.invokeTool(observer.token, 'get_market_quotes', {});
    const data = expectSuccess(response).data as { quotes: unknown[] };
    assert.deepEqual(data.quotes, []);
  });

  test('an offer targeted at another buyer cannot be accepted by a third company', async () => {
    const author = makeGrant({ companyId: TENANT_A });
    const { gateway, engine } = createGatewayFixture([author]);

    await gateway.invokeTool(author.token, 'draft_supply_offer', {
      ...draftParams('idem_iso_draft_targeted'),
      target_buyer_id: TENANT_B,
    });
    engine.processTick();
    const offer = engine.getAllContracts()[0];
    assert.equal(offer.buyerCompanyId, TENANT_B);
    publishFixtureOffer(engine, TENANT_A, offer.contractId, 'human_iso_publish_targeted');
    const offerBefore = structuredClone(engine.getContract(offer.contractId));
    const companies = [TENANT_A, TENANT_B, 'comp_manuf_01', 'comp_manuf_02'];
    const economy = () => companies.map((id) => {
      const company = engine.getCompany(id)!;
      return structuredClone({ credits: company.credits, inventory: company.inventory, reputation: company.reputation });
    });
    const economyBefore = economy();
    const historyBefore = engine.getExecutionHistory().length;

    const accepted = engine.submitCommand({
      commandId: 'cmd_iso_targeted_accept',
      companyId: 'comp_manuf_01',
      scheduledTick: engine.getCurrentTick() + 1,
      idempotencyKey: 'idem_iso_targeted_accept',
      type: 'ACCEPT_SUPPLY_OFFER',
      contractId: offer.contractId,
    });
    engine.processTick();

    assert.equal(accepted, true);
    const result = engine.getExecutionHistory().at(-1)!;
    assert.equal(result.success, false);
    assert.equal(result.errorCode, 'ERR_OFFER_NOT_FOR_BUYER');
    assert.equal(result.errorMessage, 'Only the designated buyer can accept this offer');
    assert.deepEqual(engine.getContract(offer.contractId), offerBefore);
    assert.deepEqual(economy(), economyBefore);
    assert.equal(engine.getExecutionHistory().length, historyBefore + 1);
  });

  test('re-registering a grant invalidates its previous token', {
    skip: 'pending: open P0 issue #7 — fixed-token issuance; registerGrant keeps stale token mappings',
  }, async () => {
    const original = makeGrant({ grantId: 'grant_rotating', token: 'gf_mcp_token_rotation_01' });
    const { gateway } = createGatewayFixture([original]);

    gateway.registerGrant(makeGrant({ grantId: 'grant_rotating', token: 'gf_mcp_token_rotation_02' }));

    const response = await gateway.invokeTool(original.token, 'get_inventory', overviewParams(TENANT_A));
    expectError(response, 'ERR_AUTH_INVALID');
  });
});
