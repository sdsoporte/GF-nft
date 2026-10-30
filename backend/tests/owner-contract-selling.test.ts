/**
 * Issue #58 (milestone B, player-as-seller): the owner-session selling API.
 *
 * Three additive financial routes sit next to the frozen publication route:
 *
 * - `POST /v1/owner/contracts` drafts an offer owned by the server-selected
 *   company.
 * - `POST /v1/owner/contracts/<id>/cancel` cancels an eligible own DRAFT or
 *   unaccepted PENDING offer.
 * - `POST /v1/owner/contracts/<id>/dispatch` ships goods for an own ACTIVE
 *   contract.
 *
 * Every test drives the public HTTP surface plus a real `FactoryMatch` (and a
 * real store when durability is under test); no production module is stubbed.
 * Matches are isolated, the clock is manual, and contract fixtures that the
 * routes do not yet create go through the public engine queue.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { EnqueueCommandInput, SupplyContract } from '../src/domain/types.ts';
import { request } from './helpers.ts';
import { issueGrant, ownerSession, startOwnerApp, type OwnerApp } from './owner-fixtures.ts';
import { draftParams, expectSuccess, TENANT_B } from './mcp/grant-helper.ts';

const SERVER_COMPANY = 'comp_metal_01';
const FOREIGN_BUYER = 'comp_manuf_02';

const headers = { 'content-type': 'application/json' };
const writeGrant = { phaseMode: 'PHASE_1B_READ_WRITE', scopes: ['contracts:draft', 'market:read'] };

const unauthorized = { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' } };
const notFound = { error: { code: 'NOT_FOUND', message: 'The requested resource does not exist.' } };
const invalidDraft = { error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid draft offer request.' } };
const invalidCancel = {
  error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid offer cancellation request.' },
};
const invalidDispatch = { error: { code: 'ERR_INVALID_PAYLOAD', message: 'Invalid dispatch request.' } };

const DRAFT_PATH = '/v1/owner/contracts';

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

/**
 * Absolute offer deadline that the route accepts right now.
 *
 * The route validates the horizon (deadline minus current tick) against the
 * existing command schema, so tests always compute it from the live tick.
 */
function deadlineIn(app: OwnerApp, ticks = 50): number {
  return app.handle.match.engine.getCurrentTick() + ticks;
}

function draftBody(app: OwnerApp, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotency_key: 'owner_draft_offer_0001',
    item_id: 'RAW_ORE',
    quantity: 10,
    unit_price: 5,
    deadline_tick: deadlineIn(app),
    ...overrides,
  };
}

/** Enqueue one fixture command as the next tick would, then run that tick. */
function submitAndTick(
  app: OwnerApp,
  command: Omit<EnqueueCommandInput, 'scheduledTick' | 'idempotencyKey' | 'commandId'>,
): void {
  fixtureSeed += 1;
  const commandId = `cmd_selling_fixture_${fixtureSeed}`;
  const input = {
    ...command,
    commandId,
    scheduledTick: app.handle.match.engine.getCurrentTick() + 1,
    idempotencyKey: `fixture_${commandId}`,
  } as EnqueueCommandInput;
  assert.equal(app.handle.match.engine.submitCommand(input), true, `${command.type} must enqueue`);
  app.clock.advance();
}

function ownContracts(app: OwnerApp, status: SupplyContract['status']): SupplyContract[] {
  return app.handle.match.engine
    .getAllContracts()
    .filter((contract) => contract.sellerCompanyId === SERVER_COMPANY && contract.status === status);
}

function contractPath(contractId: string, action: 'cancel' | 'dispatch' | 'publish'): string {
  return `/v1/owner/contracts/${contractId}/${action}`;
}

function post(app: OwnerApp, path: string, token: string | undefined, body: unknown) {
  return request(app, path, {
    method: 'POST',
    token,
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Draft through the new route and return the DRAFT the engine stored. */
async function draftThroughRoute(
  app: OwnerApp,
  session: string,
  overrides: Record<string, unknown> = {},
): Promise<SupplyContract> {
  const response = await post(app, DRAFT_PATH, session, draftBody(app, overrides));
  assert.equal(response.status, 202, response.text);
  app.clock.advance();
  const drafts = ownContracts(app, 'DRAFT');
  assert.equal(drafts.length, 1, 'exactly one own DRAFT must exist');
  return drafts[0];
}

/** Publish an own DRAFT through the frozen publication route. */
async function publishThroughRoute(app: OwnerApp, session: string, contractId: string): Promise<void> {
  const response = await post(app, contractPath(contractId, 'publish'), session, {
    idempotency_key: `owner_publish_fixture_${contractId}`,
  });
  assert.equal(response.status, 202, response.text);
  app.clock.advance();
}

/** Draft, publish and accept so the server company holds an ACTIVE contract. */
async function activeOwnContract(app: OwnerApp, session: string): Promise<SupplyContract> {
  const draft = await draftThroughRoute(app, session, { target_buyer_id: TENANT_B });
  await publishThroughRoute(app, session, draft.contractId);
  submitAndTick(app, { type: 'ACCEPT_SUPPLY_OFFER', companyId: TENANT_B, contractId: draft.contractId } as EnqueueCommandInput);
  const [active] = ownContracts(app, 'ACTIVE');
  assert.ok(active, 'the server company must own one ACTIVE contract');
  assert.equal(active.buyerCompanyId, TENANT_B);
  return active;
}

test('selling routes require a live owner session, never root or an MCP grant', async () => {
  let now = Date.UTC(2030, 0, 1);
  const app = await startOwnerApp({ now: () => now });
  try {
    const session = await ownerSession(app);
    const grant = await issueGrant(app, session, writeGrant);
    expectSuccess(
      await app.handle.mcp!.invokeTool(grant.token, 'draft_supply_offer', draftParams('selling_auth_draft_001')),
    );
    app.clock.advance();
    const draft = ownContracts(app, 'DRAFT')[0];
    const routes = [
      { path: DRAFT_PATH, body: draftBody(app) },
      { path: contractPath(draft.contractId, 'cancel'), body: { idempotency_key: 'selling_auth_cancel_0001' } },
      { path: contractPath(draft.contractId, 'dispatch'), body: { idempotency_key: 'selling_auth_dispatch_0001', quantity_to_ship: 1 } },
    ];
    const before = admission(app);
    for (const route of routes) {
      for (const token of [undefined, app.token, grant.token, 'gf_owner_forged']) {
        const denied = await post(app, route.path, token, route.body);
        assert.equal(denied.status, 401, `${route.path} must reject ${token ?? 'no token'}`);
        assert.deepEqual(denied.json, unauthorized);
        assert.deepEqual(admission(app), before);
      }
    }
    now += 15 * 60 * 1000;
    for (const route of routes) {
      const expired = await post(app, route.path, session, route.body);
      assert.equal(expired.status, 401, `${route.path} must reject an expired session`);
      assert.deepEqual(expired.json, unauthorized);
    }
    const fresh = await ownerSession(app);
    await request(app, '/v1/owner/sessions/current', { method: 'DELETE', token: fresh });
    for (const route of routes) {
      const loggedOut = await post(app, route.path, fresh, route.body);
      assert.equal(loggedOut.status, 401, `${route.path} must reject a logged-out session`);
      assert.deepEqual(loggedOut.json, unauthorized);
    }
    assert.deepEqual(admission(app), before);
  } finally {
    await app.close();
  }
});

test('owner draft admits exact terms and creates a DRAFT on the next tick', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const deadlineTick = deadlineIn(app, 50);
    const creditsBefore = engine.getCompany(SERVER_COMPANY)!.credits;
    const queued = await post(app, DRAFT_PATH, session, draftBody(app, {
      target_buyer_id: TENANT_B,
      deadline_tick: deadlineTick,
    }));
    assert.equal(queued.status, 202, queued.text);
    assert.deepEqual(queued.json, {
      status: 'ENQUEUED_FOR_NEXT_TICK',
      scheduledTick: engine.getCurrentTick() + 1,
      itemId: 'RAW_ORE',
      quantity: 10,
      unitPriceCredits: 5,
      deadlineTick,
      targetBuyerId: TENANT_B,
    });
    assert.equal(engine.getAllContracts().length, 0, 'admission must not create the contract');
    app.clock.advance();
    const drafts = ownContracts(app, 'DRAFT');
    assert.equal(drafts.length, 1);
    assert.deepEqual(drafts[0], {
      contractId: drafts[0].contractId,
      sellerCompanyId: SERVER_COMPANY,
      buyerCompanyId: TENANT_B,
      itemId: 'RAW_ORE',
      totalQuantity: 10,
      deliveredQuantity: 0,
      unitPriceCredits: 5,
      totalValueCredits: 50,
      collateralSellerCredits: 10,
      createdAtTick: 1,
      deadlineTick,
      penaltyPerMissingUnit: 10,
      status: 'DRAFT',
    });
    assert.equal(engine.getCompany(SERVER_COMPANY)!.credits, creditsBefore, 'a DRAFT locks no funds');
    // The frozen publication route still publishes the draft this route created,
    // and the targeted offer stays publicly listed (issue #58 milestone A).
    await publishThroughRoute(app, session, drafts[0].contractId);
    assert.equal(engine.getContract(drafts[0].contractId)!.status, 'PENDING');
    const offers = await request(app, '/v1/market/offers', { token: app.token });
    assert.equal(offers.status, 200);
    assert.deepEqual(offers.json.offers, [{
      contractId: drafts[0].contractId,
      sellerCompanyId: SERVER_COMPANY,
      buyerCompanyId: TENANT_B,
      itemId: 'RAW_ORE',
      quantity: 10,
      unitPriceCredits: 5,
      totalValueCredits: 50,
      createdAtTick: 1,
      deadlineTick,
    }]);
  } finally {
    await app.close();
  }
});

test('owner draft rejects invalid terms without admitting a command', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const before = admission(app);
    const future = deadlineIn(app, 50);
    const rejected = [
      {},
      draftBody(app, { idempotency_key: undefined }),
      draftBody(app, { idempotency_key: 'short' }),
      draftBody(app, { idempotency_key: 'bad key with spaces' }),
      draftBody(app, { item_id: 'GOLD_BAR' }),
      draftBody(app, { item_id: undefined }),
      draftBody(app, { quantity: 0 }),
      draftBody(app, { quantity: 5001 }),
      draftBody(app, { quantity: 10.5 }),
      draftBody(app, { unit_price: 0 }),
      draftBody(app, { unit_price: 100001 }),
      draftBody(app, { deadline_tick: deadlineIn(app, 9) }),
      draftBody(app, { deadline_tick: deadlineIn(app, 2701) }),
      draftBody(app, { deadline_tick: 12.5 }),
      draftBody(app, { target_buyer_id: 'not-a-company' }),
      draftBody(app, { target_buyer_id: null }),
      // Server-owned values are never accepted from the caller.
      draftBody(app, { companyId: FOREIGN_BUYER }),
      draftBody(app, { scheduledTick: future }),
      draftBody(app, { contractId: 'cnt_1_1' }),
    ];
    for (const body of rejected) {
      const response = await post(app, DRAFT_PATH, session, body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.deepEqual(response.json, invalidDraft);
      assert.deepEqual(admission(app), before);
    }
    const validJson = JSON.stringify(draftBody(app));
    const oversized = await post(app, DRAFT_PATH, session, validJson + ' '.repeat(8193 - Buffer.byteLength(validJson)));
    assert.equal(oversized.status, 413);
    assert.deepEqual(oversized.json, { error: { code: 'REQUEST_TOO_LARGE', message: 'The request body exceeds 8192 bytes.' } });
    const media = await request(app, DRAFT_PATH, { method: 'POST', token: session, body: validJson });
    assert.equal(media.status, 415);
    assert.deepEqual(media.json, {
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The draft offer request must be application/json.' },
    });
    const malformed = await post(app, DRAFT_PATH, session, '{bad');
    assert.equal(malformed.status, 400);
    assert.deepEqual(malformed.json, {
      error: { code: 'INVALID_REQUEST', message: 'The request body must be valid JSON.' },
    });
    assert.deepEqual(admission(app), before);
  } finally {
    await app.close();
  }
});

test('owner cancellation ends an eligible own DRAFT or PENDING offer only', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const draft = await draftThroughRoute(app, session);
    const queued = await post(app, contractPath(draft.contractId, 'cancel'), session, {
      idempotency_key: 'owner_cancel_draft_0001',
    });
    assert.equal(queued.status, 202, queued.text);
    assert.deepEqual(queued.json, {
      status: 'ENQUEUED_FOR_NEXT_TICK',
      scheduledTick: engine.getCurrentTick() + 1,
      contractId: draft.contractId,
    });
    assert.equal(engine.getContract(draft.contractId)!.status, 'DRAFT', 'nothing changes before the tick');
    app.clock.advance();
    assert.deepEqual(engine.getContract(draft.contractId), {
      ...draft,
      status: 'CANCELLED',
      settledAtTick: 2,
    });
    // A published but unaccepted offer is cancellable too.
    const pending = await draftThroughRoute(app, session, {
      idempotency_key: 'owner_draft_pending_0001',
      target_buyer_id: TENANT_B,
    });
    await publishThroughRoute(app, session, pending.contractId);
    const cancelled = await post(app, contractPath(pending.contractId, 'cancel'), session, {
      idempotency_key: 'owner_cancel_pending_0001',
    });
    assert.equal(cancelled.status, 202, cancelled.text);
    app.clock.advance();
    assert.equal(engine.getContract(pending.contractId)!.status, 'CANCELLED');
  } finally {
    await app.close();
  }
});

test('owner cancellation rejects unknown, foreign and ACTIVE contracts before admission', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const active = await activeOwnContract(app, session);
    // A foreign seller's DRAFT and PENDING offer are never cancellable here.
    submitAndTick(app, {
      type: 'DRAFT_SUPPLY_OFFER',
      companyId: TENANT_B,
      itemId: 'RAW_ORE',
      quantity: 4,
      unitPriceCredits: 5,
      deadlineTicks: deadlineIn(app, 40),
    } as EnqueueCommandInput);
    const foreignDraft = engine.getAllContracts().find((contract) =>
      contract.sellerCompanyId === TENANT_B && contract.status === 'DRAFT')!;
    submitAndTick(app, { type: 'PUBLISH_SUPPLY_OFFER', companyId: TENANT_B, contractId: foreignDraft.contractId } as EnqueueCommandInput);
    const foreignPending = engine.getContract(foreignDraft.contractId)!;
    assert.equal(foreignPending.status, 'PENDING');
    const before = admission(app);
    for (const contractId of ['cnt_missing_001', foreignDraft.contractId, active.contractId]) {
      const denied = await post(app, contractPath(contractId, 'cancel'), session, {
        idempotency_key: 'owner_cancel_reject_0001',
      });
      assert.equal(denied.status, 404, `cancellation of ${contractId} must be refused`);
      assert.deepEqual(denied.json, notFound);
      assert.deepEqual(admission(app), before);
    }
    const badBody = await post(app, contractPath(active.contractId, 'cancel'), session, {
      idempotency_key: 'short',
    });
    assert.equal(badBody.status, 400);
    assert.deepEqual(badBody.json, invalidCancel);
    const extraKey = await post(app, contractPath(active.contractId, 'cancel'), session, {
      idempotency_key: 'owner_cancel_extra_0001',
      companyId: FOREIGN_BUYER,
    });
    assert.equal(extraKey.status, 400);
    assert.deepEqual(extraKey.json, invalidCancel);
    assert.deepEqual(admission(app), before);
    app.clock.advance();
    assert.equal(engine.getContract(active.contractId)!.status, 'ACTIVE', 'no ACTIVE cancellation exists');
  } finally {
    await app.close();
  }
});

test('owner dispatch ships only the seller ACTIVE contract and reports queued then final', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const active = await activeOwnContract(app, session);
    const stockBefore = engine.getCompany(SERVER_COMPANY)!.inventory.RAW_ORE.available;
    const queued = await post(app, contractPath(active.contractId, 'dispatch'), session, {
      idempotency_key: 'owner_dispatch_partial_0001',
      quantity_to_ship: 4,
    });
    assert.equal(queued.status, 202, queued.text);
    assert.deepEqual(queued.json, {
      status: 'ENQUEUED_FOR_NEXT_TICK',
      scheduledTick: engine.getCurrentTick() + 1,
      contractId: active.contractId,
      quantityToShip: 4,
    });
    assert.equal(engine.getContract(active.contractId)!.deliveredQuantity, 0);
    app.clock.advance();
    const shipped = engine.getContract(active.contractId)!;
    assert.equal(shipped.deliveredQuantity, 4);
    assert.equal(shipped.status, 'ACTIVE');
    assert.equal(engine.getCompany(SERVER_COMPANY)!.inventory.RAW_ORE.available, stockBefore - 4);
    // Payload guard: server-owned values, quantity bounds and exact shape.
    const before = admission(app);
    for (const body of [
      { idempotency_key: 'owner_dispatch_bad_0001' },
      { idempotency_key: 'owner_dispatch_bad_0002', quantity_to_ship: 0 },
      { idempotency_key: 'owner_dispatch_bad_0003', quantity_to_ship: 1001 },
      { idempotency_key: 'owner_dispatch_bad_0004', quantity_to_ship: 1.5 },
      { idempotency_key: 'short', quantity_to_ship: 1 },
      { idempotency_key: 'owner_dispatch_bad_0005', quantity_to_ship: 1, companyId: FOREIGN_BUYER },
      { idempotency_key: 'owner_dispatch_bad_0006', quantity_to_ship: 1, scheduledTick: deadlineIn(app) },
    ]) {
      const denied = await post(app, contractPath(active.contractId, 'dispatch'), session, body);
      assert.equal(denied.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      assert.deepEqual(denied.json, invalidDispatch);
      assert.deepEqual(admission(app), before);
    }
  } finally {
    await app.close();
  }
});

test('owner dispatch refuses a foreign contract and any non-ACTIVE status', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const pending = await draftThroughRoute(app, session, { target_buyer_id: TENANT_B });
    await publishThroughRoute(app, session, pending.contractId);
    submitAndTick(app, {
      type: 'CREATE_SUPPLY_OFFER',
      companyId: TENANT_B,
      itemId: 'RAW_ORE',
      quantity: 4,
      unitPriceCredits: 5,
      deadlineTicks: deadlineIn(app, 40),
    } as EnqueueCommandInput);
    const foreignPending = engine.getAllContracts().find((contract) =>
      contract.sellerCompanyId === TENANT_B && contract.status === 'PENDING')!;
    submitAndTick(app, { type: 'ACCEPT_SUPPLY_OFFER', companyId: FOREIGN_BUYER, contractId: foreignPending.contractId } as EnqueueCommandInput);
    assert.equal(engine.getContract(foreignPending.contractId)!.status, 'ACTIVE');
    const before = admission(app);
    for (const contractId of ['cnt_missing_002', foreignPending.contractId, pending.contractId]) {
      const denied = await post(app, contractPath(contractId, 'dispatch'), session, {
        idempotency_key: 'owner_dispatch_refuse_0001',
        quantity_to_ship: 1,
      });
      assert.equal(denied.status, 404, `dispatch for ${contractId} must be refused`);
      assert.deepEqual(denied.json, notFound);
      assert.deepEqual(admission(app), before);
    }
    app.clock.advance();
    // The foreign seller (an NPC company) ships its own contract through its own
    // policy, so only the server company's contract is asserted here: no refused
    // dispatch ever queued a command, and the own PENDING offer stays untouched.
    assert.equal(engine.getContract(pending.contractId)!.deliveredQuantity, 0);
    assert.equal(engine.getContract(pending.contractId)!.status, 'PENDING');
    assert.equal(engine.getCommandQueue().getPendingCount(), 0);
  } finally {
    await app.close();
  }
});

test('owner selling admission is durable across an isolated backend restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gf-owner-selling-'));
  const path = join(directory, 'match.sqlite');
  let app = await startOwnerApp({ path });
  try {
    const session = await ownerSession(app);
    const deadlineTick = deadlineIn(app, 50);
    const queued = await post(app, DRAFT_PATH, session, draftBody(app, {
      idempotency_key: 'owner_durable_draft_0001',
      deadline_tick: deadlineTick,
    }));
    assert.equal(queued.status, 202, queued.text);
    await app.close();
    app = await startOwnerApp({ path });
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1);
    const fresh = await ownerSession(app);
    const retried = await post(app, DRAFT_PATH, fresh, draftBody(app, {
      idempotency_key: 'owner_durable_draft_0001',
      deadline_tick: deadlineTick,
    }));
    assert.equal(retried.status, 409);
    assert.deepEqual(retried.json, {
      error: { code: 'ERR_DUPLICATE_IDEMPOTENCY_KEY', message: 'idempotency_key duplicate' },
    });
    assert.equal(app.handle.match.engine.getCommandQueue().getPendingCount(), 1, 'a retry admits nothing');
    app.clock.advance();
    const drafts = ownContracts(app, 'DRAFT');
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].deadlineTick, deadlineTick);
    const contractId = drafts[0].contractId;
    const cancelled = await post(app, contractPath(contractId, 'cancel'), fresh, {
      idempotency_key: 'owner_durable_cancel_0001',
    });
    assert.equal(cancelled.status, 202, cancelled.text);
    await app.close();
    app = await startOwnerApp({ path });
    assert.equal(app.handle.match.engine.getContract(contractId)!.status, 'DRAFT');
    app.clock.advance();
    assert.equal(app.handle.match.engine.getContract(contractId)!.status, 'CANCELLED');
    assert.equal(app.handle.match.engine.getExecutionHistory().at(-1)!.success, true);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selling routes refuse the wrong method and reuse of one durable key', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const before = admission(app);
    for (const path of [
      DRAFT_PATH,
      contractPath('cnt_1_1', 'cancel'),
      contractPath('cnt_1_1', 'dispatch'),
    ]) {
      const read = await request(app, path, { token: session });
      assert.equal(read.status, 405, `${path} must not answer GET`);
      assert.deepEqual(read.json, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed for this route.' },
      });
      assert.deepEqual(admission(app), before);
    }
    // An open offer has no designated buyer, and the acknowledgement says so.
    const openOffer = draftBody(app, { idempotency_key: 'owner_open_offer_0001' });
    delete openOffer.target_buyer_id;
    const opened = await post(app, DRAFT_PATH, session, openOffer);
    assert.equal(opened.status, 202, opened.text);
    assert.equal(opened.json.targetBuyerId, null);
    app.clock.advance();
    const draft = ownContracts(app, 'DRAFT')[0];
    assert.equal(draft.buyerCompanyId, '');
    // One durable key is one financial command: reusing it for another action,
    // or for different terms, is refused instead of replaying or duplicating.
    const afterDraft = admission(app);
    const reusedForCancel = await post(app, contractPath(draft.contractId, 'cancel'), session, {
      idempotency_key: 'owner_open_offer_0001',
    });
    assert.equal(reusedForCancel.status, 409);
    assert.deepEqual(reusedForCancel.json, {
      error: { code: 'ERR_DUPLICATE_IDEMPOTENCY_KEY', message: 'idempotency_key duplicate' },
    });
    const reusedWithOtherTerms = await post(app, DRAFT_PATH, session, draftBody(app, {
      idempotency_key: 'owner_open_offer_0001',
      quantity: 999,
    }));
    assert.equal(reusedWithOtherTerms.status, 409);
    assert.deepEqual(admission(app), afterDraft);
    app.clock.advance();
    assert.equal(engine.getContract(draft.contractId)!.status, 'DRAFT');
    assert.equal(ownContracts(app, 'DRAFT').length, 1);
  } finally {
    await app.close();
  }
});

test('the frozen owner publication route keeps its admission and response', async () => {
  const app = await startOwnerApp();
  try {
    const session = await ownerSession(app);
    const engine = app.handle.match.engine;
    const draft = await draftThroughRoute(app, session);
    const published = await post(app, contractPath(draft.contractId, 'publish'), session, {
      idempotency_key: 'owner_regression_publish_0001',
    });
    assert.equal(published.status, 202, published.text);
    assert.deepEqual(published.json, {
      status: 'ENQUEUED_FOR_NEXT_TICK',
      scheduledTick: engine.getCurrentTick() + 1,
      contractId: draft.contractId,
    });
    assert.equal(engine.getContract(draft.contractId)!.status, 'DRAFT');
    const duplicate = await post(app, contractPath(draft.contractId, 'publish'), session, {
      idempotency_key: 'owner_regression_publish_0001',
    });
    assert.equal(duplicate.status, 409);
    assert.equal(engine.getCommandQueue().getPendingCount(), 1);
    app.clock.advance();
    assert.deepEqual(engine.getContract(draft.contractId), { ...draft, status: 'PENDING' });
    assert.equal(app.handle.match.getAcknowledgedRequestCount(), 0);
  } finally {
    await app.close();
  }
});
