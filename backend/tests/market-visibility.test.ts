/**
 * Issue #58 (milestone A): read-only market visibility for the player.
 *
 * `GET /v1/market/offers` publishes the pending, unexpired supply book and
 * `GET /v1/contracts` publishes the server-selected company's own contracts.
 * Both routes are additive, root-bearer authenticated reads: they project the
 * same engine data the MCP tools `get_market_quotes` and `get_contracts` already
 * project, they never mutate the match and they expose no trading controls.
 *
 * Every test owns an isolated in-memory match. Contracts are created through the
 * public engine queue (`submitCommand` + the server-owned manual clock), so no
 * assertion depends on wall-clock time, unseeded randomness or private state.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { EnqueueCommandInput, SupplyContract } from '../src/domain/types.ts';
import {
  executionCount,
  pendingCommandCount,
  readState,
  request,
  withTestServer,
  type HttpResponse,
  type TestApp,
} from './helpers.ts';

const SERVER_COMPANY = 'comp_metal_01';
const FOREIGN_SELLER = 'comp_metal_02';
const FOREIGN_BUYER = 'comp_manuf_02';

const UNAUTHORIZED = { error: { code: 'UNAUTHORIZED', message: 'A valid bearer token is required.' } };
const METHOD_NOT_ALLOWED = {
  error: { code: 'METHOD_NOT_ALLOWED', message: 'The method is not allowed for this route.' },
};

const OFFERS_PATH = '/v1/market/offers';
const CONTRACTS_PATH = '/v1/contracts';

let commandSeed = 0;

interface OfferInput {
  readonly companyId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly unitPriceCredits: number;
  readonly deadlineTicks: number;
  readonly targetBuyerId?: string;
  readonly draft?: boolean;
}

/** Enqueue one command as the next server tick would, then run that tick. */
function submitAndTick(app: TestApp, command: Omit<EnqueueCommandInput, 'scheduledTick' | 'idempotencyKey' | 'commandId'>): void {
  commandSeed += 1;
  const commandId = `cmd_mv_${commandSeed}`;
  const input = {
    ...command,
    commandId,
    scheduledTick: app.handle.match.engine.getCurrentTick() + 1,
    idempotencyKey: `idem_${commandId}`,
  } as EnqueueCommandInput;
  assert.equal(app.handle.match.engine.submitCommand(input), true, `${command.type} must enqueue`);
  app.clock.advance();
}

function contractIds(app: TestApp): Set<string> {
  return new Set(app.handle.match.engine.getAllContracts().map((contract) => contract.contractId));
}

/** Create one offer and return the contract the engine actually stored. */
function createOffer(app: TestApp, offer: OfferInput): SupplyContract {
  const before = contractIds(app);
  submitAndTick(app, {
    type: offer.draft ? 'DRAFT_SUPPLY_OFFER' : 'CREATE_SUPPLY_OFFER',
    companyId: offer.companyId,
    itemId: offer.itemId,
    quantity: offer.quantity,
    unitPriceCredits: offer.unitPriceCredits,
    deadlineTicks: offer.deadlineTicks,
    ...(offer.targetBuyerId === undefined ? {} : { targetBuyerId: offer.targetBuyerId }),
  } as EnqueueCommandInput);
  const created = app.handle.match.engine
    .getAllContracts()
    .filter((contract) => !before.has(contract.contractId))
    .filter(
      (contract) =>
        contract.sellerCompanyId === offer.companyId &&
        contract.itemId === offer.itemId &&
        contract.totalQuantity === offer.quantity &&
        contract.unitPriceCredits === offer.unitPriceCredits,
    );
  assert.equal(created.length, 1, 'exactly one offer must be created by the command');
  return created[0];
}

function acceptOffer(app: TestApp, companyId: string, contractId: string): void {
  submitAndTick(app, { type: 'ACCEPT_SUPPLY_OFFER', companyId, contractId } as EnqueueCommandInput);
}

function ship(app: TestApp, companyId: string, contractId: string, quantityToShip: number): void {
  submitAndTick(app, {
    type: 'SCHEDULE_INTERNAL_TRANSPORT',
    companyId,
    contractId,
    quantityToShip,
  } as EnqueueCommandInput);
}

/** Give a company stock without simulating production of it. */
function setAvailableStock(app: TestApp, companyId: string, itemId: string, available: number): void {
  const company = app.handle.match.engine.getCompany(companyId);
  assert.ok(company, `company ${companyId} must exist`);
  (company.inventory as unknown as Record<string, { available: number }>)[itemId].available = available;
}

async function readOffers(app: TestApp): Promise<HttpResponse> {
  return request(app, OFFERS_PATH, { token: app.token });
}

async function readContracts(app: TestApp): Promise<HttpResponse> {
  return request(app, CONTRACTS_PATH, { token: app.token });
}

function findOffer(book: readonly any[], contractId: string): any {
  return book.find((offer) => offer.contractId === contractId);
}

test('both market reads require the root bearer token', async () => {
  await withTestServer(async (app) => {
    for (const path of [OFFERS_PATH, CONTRACTS_PATH]) {
      for (const token of [null, 'wrong-token-0123456789abcdef01234567']) {
        const denied = await request(app, path, { token });
        assert.equal(denied.status, 401, `${path} without a root token must be 401`);
        assert.deepEqual(denied.json, UNAUTHORIZED);
      }
    }
  });
});

test('an empty book and an empty contract list are explicit empty arrays', async () => {
  await withTestServer(async (app) => {
    const offers = await readOffers(app);
    assert.equal(offers.status, 200);
    assert.equal(offers.contentType, 'application/json; charset=utf-8');
    assert.deepEqual(offers.json, { tick: 0, offers: [] });

    const contracts = await readContracts(app);
    assert.equal(contracts.status, 200);
    assert.equal(contracts.contentType, 'application/json; charset=utf-8');
    assert.deepEqual(contracts.json, { tick: 0, companyId: SERVER_COMPANY, contracts: [] });
  });
});

test('the public book lists pending unexpired offers with seller attribution', async () => {
  await withTestServer(async (app) => {
    const own = createOffer(app, {
      companyId: SERVER_COMPANY,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 6000,
      deadlineTicks: 50,
    });
    const foreign = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 2,
      unitPriceCredits: 400,
      deadlineTicks: 80,
    });
    const targeted = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 3,
      unitPriceCredits: 300,
      deadlineTicks: 90,
      targetBuyerId: FOREIGN_BUYER,
    });

    const response = await readOffers(app);
    assert.equal(response.status, 200);
    assert.equal(response.json.tick, app.handle.match.engine.getCurrentTick());

    assert.deepEqual(findOffer(response.json.offers, own.contractId), {
      contractId: own.contractId,
      sellerCompanyId: SERVER_COMPANY,
      buyerCompanyId: null,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 6000,
      totalValueCredits: 6000,
      createdAtTick: own.createdAtTick,
      deadlineTick: 50,
    });
    assert.deepEqual(findOffer(response.json.offers, foreign.contractId), {
      contractId: foreign.contractId,
      sellerCompanyId: FOREIGN_SELLER,
      buyerCompanyId: null,
      itemId: 'MEGAMACHINE_PART',
      quantity: 2,
      unitPriceCredits: 400,
      totalValueCredits: 800,
      createdAtTick: foreign.createdAtTick,
      deadlineTick: 80,
    });
    assert.equal(findOffer(response.json.offers, targeted.contractId).buyerCompanyId, FOREIGN_BUYER);

    // Every published entry carries exactly the documented keys, nothing else.
    for (const offer of response.json.offers) {
      assert.deepEqual(Object.keys(offer).sort(), [
        'buyerCompanyId',
        'contractId',
        'createdAtTick',
        'deadlineTick',
        'itemId',
        'quantity',
        'sellerCompanyId',
        'totalValueCredits',
        'unitPriceCredits',
      ]);
    }
  });
});

test('drafts stay private: no draft of any company appears in the public book', async () => {
  await withTestServer(async (app) => {
    const ownDraft = createOffer(app, {
      companyId: SERVER_COMPANY,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 6000,
      deadlineTicks: 50,
      draft: true,
    });
    const foreignDraft = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 400,
      deadlineTicks: 50,
      draft: true,
    });
    assert.equal(ownDraft.status, 'DRAFT');
    assert.equal(foreignDraft.status, 'DRAFT');

    const response = await readOffers(app);
    assert.equal(response.status, 200);
    assert.equal(findOffer(response.json.offers, ownDraft.contractId), undefined);
    assert.equal(findOffer(response.json.offers, foreignDraft.contractId), undefined);
    assert.deepEqual(response.json.offers, []);
  });
});

test('pending offers past their deadline leave the book without the engine mutating them', async () => {
  await withTestServer(async (app) => {
    const shortLived = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 400,
      // Creation runs on tick 1, so this deadline is reachable but temporary.
      deadlineTicks: 3,
    });
    const longLived = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 400,
      deadlineTicks: 500,
    });

    const fresh = await readOffers(app);
    assert.ok(findOffer(fresh.json.offers, shortLived.contractId), 'the offer is tradable on its deadline tick');
    assert.ok(findOffer(fresh.json.offers, longLived.contractId));

    app.clock.advance(5);

    const expired = await readOffers(app);
    assert.equal(expired.status, 200);
    assert.equal(findOffer(expired.json.offers, shortLived.contractId), undefined);
    assert.ok(findOffer(expired.json.offers, longLived.contractId));
    // The read-only route reports the engine as it is: the expired offer is
    // still PENDING until a mutating slice decides what to do with it.
    assert.equal(app.handle.match.engine.getContract(shortLived.contractId)!.status, 'PENDING');
  });
});

test('own contracts expose delivery progress, prices, deadlines and status', async () => {
  await withTestServer(async (app) => {
    const offer = createOffer(app, {
      companyId: SERVER_COMPANY,
      itemId: 'MEGAMACHINE_PART',
      quantity: 2,
      unitPriceCredits: 10,
      deadlineTicks: 200,
    });
    acceptOffer(app, FOREIGN_BUYER, offer.contractId);
    setAvailableStock(app, SERVER_COMPANY, 'MEGAMACHINE_PART', 5);
    ship(app, SERVER_COMPANY, offer.contractId, 1);

    const active = app.handle.match.engine.getContract(offer.contractId)!;
    assert.equal(active.status, 'ACTIVE');
    assert.equal(active.deliveredQuantity, 1);

    const partial = await readContracts(app);
    assert.equal(partial.status, 200);
    assert.equal(partial.json.tick, app.handle.match.engine.getCurrentTick());
    assert.equal(partial.json.companyId, SERVER_COMPANY);
    const partialEntry = partial.json.contracts.find((c: any) => c.contractId === offer.contractId);
    assert.deepEqual(partialEntry, {
      contractId: offer.contractId,
      sellerCompanyId: SERVER_COMPANY,
      buyerCompanyId: FOREIGN_BUYER,
      itemId: 'MEGAMACHINE_PART',
      totalQuantity: 2,
      deliveredQuantity: 1,
      unitPriceCredits: 10,
      totalValueCredits: 20,
      collateralSellerCredits: 4,
      createdAtTick: active.createdAtTick,
      deadlineTick: 200,
      status: 'ACTIVE',
      settledAtTick: null,
    });

    ship(app, SERVER_COMPANY, offer.contractId, 1);
    const fulfilled = await readContracts(app);
    const fulfilledEntry = fulfilled.json.contracts.find((c: any) => c.contractId === offer.contractId);
    assert.equal(fulfilledEntry.status, 'FULFILLED');
    assert.equal(fulfilledEntry.deliveredQuantity, 2);
    assert.equal(fulfilledEntry.settledAtTick, app.handle.match.engine.getContract(offer.contractId)!.settledAtTick);
    for (const entry of fulfilled.json.contracts) {
      assert.deepEqual(Object.keys(entry).sort(), [
        'buyerCompanyId',
        'collateralSellerCredits',
        'contractId',
        'createdAtTick',
        'deadlineTick',
        'deliveredQuantity',
        'itemId',
        'sellerCompanyId',
        'settledAtTick',
        'status',
        'totalQuantity',
        'totalValueCredits',
        'unitPriceCredits',
      ]);
    }
  });
});

test('contracts are scoped to the server company and foreign drafts never leak', async () => {
  await withTestServer(async (app) => {
    const ownDraft = createOffer(app, {
      companyId: SERVER_COMPANY,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 6000,
      deadlineTicks: 50,
      draft: true,
    });
    const foreignDraft = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 400,
      deadlineTicks: 50,
      draft: true,
    });
    const foreignOffer = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 400,
      deadlineTicks: 150,
    });
    acceptOffer(app, FOREIGN_BUYER, foreignOffer.contractId);

    const response = await readContracts(app);
    assert.equal(response.status, 200);
    const ids = response.json.contracts.map((entry: any) => entry.contractId);
    assert.deepEqual(ids, [ownDraft.contractId], 'only the own draft is visible');
    assert.equal(ids.includes(foreignDraft.contractId), false);
    assert.equal(ids.includes(foreignOffer.contractId), false);
    assert.equal(response.json.contracts[0].status, 'DRAFT');
  });
});

test('a contract where the server company is the buyer is own as well', async () => {
  await withTestServer(async (app) => {
    const offer = createOffer(app, {
      companyId: FOREIGN_SELLER,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 10,
      deadlineTicks: 200,
      targetBuyerId: SERVER_COMPANY,
    });
    acceptOffer(app, SERVER_COMPANY, offer.contractId);

    const response = await readContracts(app);
    assert.equal(response.status, 200);
    const entry = response.json.contracts.find((c: any) => c.contractId === offer.contractId);
    assert.ok(entry, 'a contract bought by the server company is own');
    assert.equal(entry.sellerCompanyId, FOREIGN_SELLER);
    assert.equal(entry.buyerCompanyId, SERVER_COMPANY);
    assert.equal(entry.status, 'ACTIVE');
    assert.equal(entry.deliveredQuantity, 0);
  });
});

test('the snapshot tick tracks the authoritative match tick', async () => {
  await withTestServer(async (app) => {
    app.clock.advance(3);
    const offers = await readOffers(app);
    const contracts = await readContracts(app);
    const state = await readState(app);
    assert.equal(offers.json.tick, 3);
    assert.equal(contracts.json.tick, 3);
    assert.equal(state.tick, 3);
  });
});

test('npc surplus offers surface in the public book', async () => {
  await withTestServer(async (app) => {
    let npcOffer: any;
    // NPC surplus only exists once their lines have produced above their target
    // buffer, so the deterministic seed needs a handful of ticks to get there.
    for (let attempt = 0; attempt < 15 && npcOffer === undefined; attempt += 1) {
      app.clock.advance();
      const response = await readOffers(app);
      npcOffer = response.json.offers.find(
        (offer: any) => offer.sellerCompanyId !== SERVER_COMPANY,
      );
    }
    assert.ok(npcOffer, 'an NPC surplus offer must appear in the book');
    const seller = app.handle.match.engine.getCompany(npcOffer.sellerCompanyId);
    assert.equal(seller?.isNPC, true);
    assert.equal(app.handle.match.engine.getContract(npcOffer.contractId)!.status, 'PENDING');
  });
});

test('both routes are read-only: no command, no state change, no write method', async () => {
  await withTestServer(async (app) => {
    const offer = createOffer(app, {
      companyId: SERVER_COMPANY,
      itemId: 'MEGAMACHINE_PART',
      quantity: 1,
      unitPriceCredits: 6000,
      deadlineTicks: 50,
    });
    const before = {
      pending: pendingCommandCount(app),
      executions: executionCount(app),
      contracts: structuredClone(app.handle.match.engine.getAllContracts()),
      state: await readState(app),
    };

    for (let round = 0; round < 3; round += 1) {
      assert.equal((await readOffers(app)).status, 200);
      assert.equal((await readContracts(app)).status, 200);
    }

    assert.equal(pendingCommandCount(app), before.pending);
    assert.equal(executionCount(app), before.executions);
    assert.deepEqual(app.handle.match.engine.getAllContracts(), before.contracts);
    assert.deepEqual(await readState(app), before.state);

    for (const path of [OFFERS_PATH, CONTRACTS_PATH]) {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const refused = await request(app, path, { method, token: app.token });
        assert.equal(refused.status, 405, `${method} ${path} must be 405`);
        assert.deepEqual(refused.json, METHOD_NOT_ALLOWED);
      }
    }
    assert.equal(app.handle.match.engine.getContract(offer.contractId)!.status, 'PENDING');
    assert.equal(pendingCommandCount(app), before.pending);
  });
});
