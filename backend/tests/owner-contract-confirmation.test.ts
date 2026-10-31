/**
 * Issue #58 (milestone B, player-as-seller): the authenticated confirmation read
 * model behind the human confirmation step.
 *
 * The selling routes of T2 write the seller loop but cannot read it back: the
 * engine assigns `contractId` while executing a queued draft, and the financial
 * consequences a human must approve (buyer escrow, seller collateral, market
 * fee, default indemnity) are engine-owned. This suite pins the additive
 * `GET /v1/owner/selling` read model that closes that gap without touching the
 * public market disclosure or the frozen seller routes.
 *
 * Every test drives the public HTTP surface plus a real `FactoryMatch`; no
 * production module is stubbed. Matches are isolated and the clock is manual.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EnqueueCommandInput } from '../src/domain/types.ts';
import { request } from './helpers.ts';
import { issueGrant, ownerSession, startOwnerApp, type OwnerApp } from './owner-fixtures.ts';
import { TENANT_B } from './mcp/grant-helper.ts';

const SERVER_COMPANY = 'comp_metal_01';
const FOREIGN_SELLER = 'comp_metal_02';
const SELLING_PATH = '/v1/owner/selling';
const DRAFT_PATH = '/v1/owner/contracts';

const headers = { 'content-type': 'application/json' };
const readGrant = { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read', 'market:read'] };

const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' } };
const methodNotAllowed = {
  error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed for this route.' },
};

let fixtureSeed = 0;

/** Route-level admission evidence: nothing queued, sequenced or acknowledged. */
function admission(app: OwnerApp) {
  return {
    snapshot: app.handle.match.engine.createSnapshot(),
    pending: app.handle.match.engine.getCommandQueue().getPendingCount(),
    sequence: app.handle.match.engine.getCommandQueue().getSequenceCounter(),
    acknowledged: app.handle.match.getAcknowledgedRequestCount(),
  };
}

function deadlineIn(app: OwnerApp, ticks = 50): number {
  return app.handle.match.engine.getCurrentTick() + ticks;
}

function draftBody(app: OwnerApp, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotency_key: 'confirm_draft_offer_0001',
    item_id: 'RAW_ORE',
    quantity: 10,
    unit_price: 5,
    deadline_tick: deadlineIn(app),
    ...overrides,
  };
}

function post(app: OwnerApp, path: string, token: string | undefined, body: unknown) {
  return request(app, path, {
    method: 'POST',
    token,
    headers,
    body: JSON.stringify(body),
  });
}

function readSelling(app: OwnerApp, token: string) {
  return request(app, SELLING_PATH, { token });
}

/** Enqueue one fixture command as the next tick would, then run that tick. */
function submitAndTick(app: OwnerApp, command: Record<string, unknown>): void {
  fixtureSeed += 1;
  const commandId = `cmd_confirmation_fixture_${fixtureSeed}`;
  assert.equal(
    app.handle.match.engine.submitCommand({
      ...command,
      commandId,
      scheduledTick: app.handle.match.engine.getCurrentTick() + 1,
      idempotencyKey: `fixture_${commandId}`,
    } as EnqueueCommandInput),
    true,
    `${command.type} must enqueue`,
  );
  app.clock.advance();
}

/** Draft through the selling route and run the tick that creates the DRAFT. */
async function draftThroughRoute(
  app: OwnerApp,
  session: string,
  overrides: Record<string, unknown> = {},
) {
  const queued = await post(app, DRAFT_PATH, session, draftBody(app, overrides));
  assert.equal(queued.status, 202, queued.text);
  const key = String((draftBody(app, overrides) as Record<string, unknown>).idempotency_key);
  app.clock.advance();
  const drafts = app.handle.match.engine
    .getAllContracts()
    .filter((contract) => contract.sellerCompanyId === SERVER_COMPANY && contract.status === 'DRAFT');
  const stored = drafts.find((contract) => contract.deadlineTick === queued.json.deadlineTick);
  assert.ok(stored, 'the queued draft must create one own DRAFT');
  return { contract: stored, key };
}

test('the confirmation read model requires a live owner session', async () => {
  let now = Date.UTC(2030, 0, 1);
  const app = await startOwnerApp({ now: () => now });
  try {
    const session = await ownerSession(app);
    const grant = await issueGrant(app, session, readGrant);
    const before = admission(app);
    for (const token of [undefined, app.token, grant.token, 'gf_owner_forged']) {
      const denied = await readSelling(app, token as string | undefined as string);
      assert.equal(denied.status, 401, `the read model must reject ${token ?? 'no token'}`);
      assert.deepEqual(denied.json, unauthorized);
    }
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const refused = await request(app, SELLING_PATH, {
        method,
        token: session,
        ...(method === 'POST' ? { headers, body: '{}' } : {}),
      });
      assert.equal(refused.status, 405, `${method} ${SELLING_PATH} must not be allowed`);
      assert.deepEqual(refused.json, methodNotAllowed);
    }
    assert.deepEqual(admission(app), before, 'reads and refusals admit nothing');

    now += 15 * 60 * 1000;
    const expired = await readSelling(app, session);
    assert.equal(expired.status, 401, 'an expired session cannot read the seller loop');
    assert.deepEqual(expired.json, unauthorized);
  } finally {
    await app.close();
  }
});

test('the read model reports the engine terms a human must approve', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const { contract } = await draftThroughRoute(app, session);

    const response = await readSelling(app, session);
    assert.equal(response.status, 200, response.text);
    const payload = response.json;
    assert.equal(payload.tick, engine.getCurrentTick());
    assert.equal(payload.companyId, SERVER_COMPANY);
    assert.equal(payload.availableCredits, engine.getCompany(SERVER_COMPANY)!.credits);
    assert.equal(payload.marketFeeBps, 200);

    const [projected] = payload.contracts as Record<string, unknown>[];
    assert.deepEqual(projected, {
      contractId: contract.contractId,
      sellerCompanyId: SERVER_COMPANY,
      // An open offer has no designated buyer on the wire.
      buyerCompanyId: null,
      itemId: 'RAW_ORE',
      totalQuantity: 10,
      deliveredQuantity: 0,
      unitPriceCredits: 5,
      totalValueCredits: 50,
      collateralSellerCredits: 10,
      createdAtTick: contract.createdAtTick,
      deadlineTick: contract.deadlineTick,
      status: 'DRAFT',
      settledAtTick: null,
      // 10 x 5 = 50 to escrow, 20% = 10 collateral, 2% = 1 market fee,
      // 10 credits per missing unit, indemnity capped by the collateral.
      consequences: {
        buyerEscrowCredits: 50,
        sellerCollateralCredits: 10,
        marketFeeCredits: 1,
        sellerNetOnFullDeliveryCredits: 49,
        penaltyPerMissingUnitCredits: 10,
        maximumDefaultIndemnityCredits: 10,
      },
    });
    assert.equal(response.text.includes('gf_owner_'), false, 'the read model never echoes a session token');
  } finally {
    await app.close();
  }
});

test('the read model follows delivery and settlement of the seller contract', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const { contract } = await draftThroughRoute(app, session, {
      idempotency_key: 'confirm_publish_offer_0001',
      target_buyer_id: TENANT_B,
    });
    const published = await post(app, `${DRAFT_PATH}/${contract.contractId}/publish`, session, {
      idempotency_key: 'confirm_publish_action_0001',
    });
    assert.equal(published.status, 202, published.text);
    app.clock.advance();
    submitAndTick(app, {
      type: 'ACCEPT_SUPPLY_OFFER',
      companyId: TENANT_B,
      contractId: contract.contractId,
    });

    const active = await readSelling(app, session);
    const [accepted] = active.json.contracts as Record<string, unknown>[];
    assert.equal(accepted.status, 'ACTIVE');
    assert.equal(accepted.buyerCompanyId, TENANT_B);
    assert.equal(accepted.deliveredQuantity, 0);
    const activeConsequences = accepted.consequences as Record<string, number>;
    assert.equal(activeConsequences.buyerEscrowCredits, 50);
    assert.equal(activeConsequences.sellerCollateralCredits, 10);

    const dispatched = await post(app, `${DRAFT_PATH}/${contract.contractId}/dispatch`, session, {
      idempotency_key: 'confirm_dispatch_action_0001',
      quantity_to_ship: 10,
    });
    assert.equal(dispatched.status, 202, dispatched.text);
    app.clock.advance();

    const settled = await readSelling(app, session);
    const [fulfilled] = settled.json.contracts as Record<string, unknown>[];
    assert.equal(fulfilled.status, 'FULFILLED');
    assert.equal(fulfilled.deliveredQuantity, 10);
    assert.equal(fulfilled.settledAtTick, engine.getCurrentTick());
    // Full delivery pays gross minus the 2% fee and returns the collateral.
    assert.equal(engine.getCompany(SERVER_COMPANY)!.credits > 0, true);
  } finally {
    await app.close();
  }
});

test('the read model reports queued commands as final outcomes by idempotency key', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const { key } = await draftThroughRoute(app, session);

    const afterDraft = await readSelling(app, session);
    const executed = (afterDraft.json.recentCommands as Record<string, unknown>[]).find(
      (entry) => entry.idempotencyKey === key,
    );
    assert.deepEqual(executed, {
      idempotencyKey: key,
      status: 'executed',
      executedAtTick: app.handle.match.engine.getCurrentTick(),
      errorCode: null,
    });

    // An engine refusal is reported with its exact code, not as silence.
    const huge = await draftThroughRoute(app, session, {
      idempotency_key: 'confirm_huge_collateral_0001',
      quantity: 5000,
      unit_price: 100000,
      deadline_tick: deadlineIn(app, 60),
    });
    const refused = await post(app, `${DRAFT_PATH}/${huge.contract.contractId}/publish`, session, {
      idempotency_key: 'confirm_publish_refused_0001',
    });
    assert.equal(refused.status, 202, refused.text);
    app.clock.advance();
    assert.equal(app.handle.match.engine.getContract(huge.contract.contractId)!.status, 'DRAFT');
    const afterRefusal = await readSelling(app, session);
    const rejected = (afterRefusal.json.recentCommands as Record<string, unknown>[]).find(
      (entry) => entry.idempotencyKey === 'confirm_publish_refused_0001',
    );
    assert.deepEqual(rejected, {
      idempotencyKey: 'confirm_publish_refused_0001',
      status: 'rejected',
      executedAtTick: app.handle.match.engine.getCurrentTick(),
      errorCode: 'ERR_INSUFFICIENT_COLLATERAL',
    });
  } finally {
    await app.close();
  }
});

test('the read model never discloses a foreign seller contract', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    submitAndTick(app, {
      type: 'CREATE_SUPPLY_OFFER',
      companyId: FOREIGN_SELLER,
      itemId: 'RAW_ORE',
      quantity: 4,
      unitPriceCredits: 7,
      deadlineTicks: deadlineIn(app, 40),
    });
    const foreign = app.handle.match.engine
      .getAllContracts()
      .filter((contract) => contract.sellerCompanyId === FOREIGN_SELLER);
    assert.equal(foreign.length, 1, 'the fixture must create one foreign offer');
    const before = admission(app);

    const response = await readSelling(app, session);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.json.contracts, []);
    assert.deepEqual(admission(app), before, 'the read model changes no state');
  } finally {
    await app.close();
  }
});
