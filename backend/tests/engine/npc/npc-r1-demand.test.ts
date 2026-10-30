/// <reference types="node" />

/**
 * Issue #58 (S11, human-approved NPC configuration exception).
 *
 * S2 asks for a sell-first loop that ends with a real NPC purchase of the R1
 * output. R1 produces `IRON_INGOT`, and Issue #13's retention-derived default
 * gave every NPC an `IRON_INGOT` target buffer of zero, so the metallurgy NPC
 * never needed the player's ingots: a targeted ingot offer stayed `PENDING`
 * until its deadline while an ore offer was accepted normally.
 *
 * The approved exception is exactly one company and one item:
 *
 * - `comp_metal_02` keeps a target buffer of **5** `IRON_INGOT`, one R1 batch.
 * - The NPC therefore buys ingots while below that buffer and still retains
 *   five before releasing surplus.
 * - Starting stock, every other NPC buffer, the buy algorithm, the price
 *   margins, the fees and the credit rules are unchanged.
 *
 * These tests drive the real default configuration and a real `FactoryMatch`,
 * whose tick loop runs the NPC policies itself. No policy call is manual here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EnqueueCommandInput, ItemId, SupplyContract } from '../../../src/domain/types.ts';
import { getRecipe } from '../../../src/domain/recipeCatalog.ts';
import { FactoryMatch } from '../../../src/match.ts';
import {
  DEFAULT_NPC_CONFIG_CLASS_A,
  DEFAULT_NPC_CONFIG_CLASS_B,
  METALLURGY_INGOT_TARGET_BUFFER,
} from '../../../src/engine/npc/NpcController.ts';
import {
  DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT,
  DEFAULT_NPC_SELL_MARGIN_PERCENT,
  DEFAULT_STARTING_STOCK,
  NPC_INITIAL_STOCK_RETENTION_RATIO,
  computeTargetBufferFromInitialStock,
} from '../../../src/engine/npc/types.ts';

const METALLURGY_NPC = 'comp_metal_02';
const MANUFACTURING_NPC = 'comp_manuf_02';
const PLAYER = 'comp_metal_01';
/** The human-approved value, kept literal here so the test pins the decision. */
const APPROVED_INGOT_BUFFER = 5;

const ITEM_IDS: readonly ItemId[] = [
  'RAW_ORE', 'IRON_INGOT', 'STEEL_PLATE', 'HEAVY_ALLOY', 'MECH_FRAME',
  'CTRL_CIRCUIT', 'POWER_MODULE', 'IND_TURBINE', 'MEGAMACHINE_PART',
];

let fixtureSeed = 0;

/** The existing, unchanged NPC buy ceiling: base unit cost at 0% margin. */
function npcMaxBuyPrice(itemId: ItemId): number {
  const definition = itemId === 'IRON_INGOT' ? getRecipe('R1') : undefined;
  assert.ok(definition, 'the ingot ceiling is derived from the shipped R1 recipe');
  return Math.max(
    1,
    Math.round(
      (definition.estimatedBaseCostCredits / definition.outputQuantity) *
        (1 + DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT / 100),
    ),
  );
}

/** Admit one player offer through the public engine queue, then run its tick. */
function offerFromPlayer(
  match: FactoryMatch,
  offer: {
    readonly itemId: ItemId;
    readonly quantity: number;
    readonly unitPriceCredits: number;
    readonly targetBuyerId?: string;
  },
): void {
  fixtureSeed += 1;
  const commandId = `cmd_r1_demand_fixture_${fixtureSeed}`;
  assert.equal(
    match.engine.submitCommand({
      type: 'CREATE_SUPPLY_OFFER',
      commandId,
      companyId: PLAYER,
      scheduledTick: match.engine.getCurrentTick() + 1,
      idempotencyKey: `fixture_${commandId}`,
      itemId: offer.itemId,
      quantity: offer.quantity,
      unitPriceCredits: offer.unitPriceCredits,
      deadlineTicks: match.engine.getCurrentTick() + 200,
      ...(offer.targetBuyerId === undefined ? {} : { targetBuyerId: offer.targetBuyerId }),
    } as EnqueueCommandInput),
    true,
  );
  // One tick creates the offer; the next tick is when NPC policies see it.
  match.advanceTicks(1);
}

/** The player's pending offer for one item, or undefined. */
function pendingPlayerOffer(match: FactoryMatch, itemId: ItemId): SupplyContract | undefined {
  return match.engine
    .getAllContracts()
    .find(
      (contract) =>
        contract.sellerCompanyId === PLAYER &&
        contract.itemId === itemId &&
        contract.status === 'PENDING',
    );
}

/** Run ticks until the player's offer leaves `PENDING`, bounded by `limit`. */
function tickUntilDecided(match: FactoryMatch, contractId: string, limit = 40): SupplyContract {
  for (let tick = 0; tick < limit; tick += 1) {
    match.advanceTicks(1);
    const contract = match.engine.getContract(contractId);
    assert.ok(contract, 'the player offer still exists');
    if (contract.status !== 'PENDING') return contract;
  }
  const stuck = match.engine.getContract(contractId);
  assert.ok(stuck, 'the player offer still exists');
  return stuck;
}

test('the approved default keeps exactly one R1 batch of ingot demand', () => {
  assert.equal(
    METALLURGY_INGOT_TARGET_BUFFER,
    APPROVED_INGOT_BUFFER,
    'the exported approved constant is the five-ingot batch',
  );
  assert.equal(
    DEFAULT_NPC_CONFIG_CLASS_A.targetBuffer.IRON_INGOT,
    APPROVED_INGOT_BUFFER,
    'comp_metal_02 demands five IRON_INGOT, one R1 output batch',
  );
  assert.equal(DEFAULT_NPC_CONFIG_CLASS_A.companyId, METALLURGY_NPC);
  assert.deepEqual(DEFAULT_NPC_CONFIG_CLASS_A.preferredRecipes, ['R1', 'R2', 'R3']);
  assert.equal(
    DEFAULT_NPC_CONFIG_CLASS_A.targetBuffer.IRON_INGOT,
    getRecipe('R1').outputQuantity,
    'the approved buffer equals the R1 output quantity, not a second rule',
  );
});

test('no other default buffer or starting stock changes', () => {
  const retentionDefaults = computeTargetBufferFromInitialStock(DEFAULT_STARTING_STOCK);

  assert.equal(DEFAULT_STARTING_STOCK.IRON_INGOT, 0, 'no NPC or player is granted starting ingots');
  assert.equal(DEFAULT_STARTING_STOCK.RAW_ORE, 200, 'starting ore is unchanged');
  assert.equal(NPC_INITIAL_STOCK_RETENTION_RATIO, 0.5, 'the retention ratio is unchanged');
  assert.equal(DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT, 0, 'the buy ceiling is unchanged');
  assert.equal(DEFAULT_NPC_SELL_MARGIN_PERCENT, 20, 'the sell margin is unchanged');
  assert.equal(
    retentionDefaults.IRON_INGOT,
    0,
    'the shared retention helper still derives a zero ingot buffer',
  );

  for (const itemId of ITEM_IDS) {
    const expected = itemId === 'IRON_INGOT' ? APPROVED_INGOT_BUFFER : retentionDefaults[itemId];
    assert.equal(
      DEFAULT_NPC_CONFIG_CLASS_A.targetBuffer[itemId],
      expected,
      `comp_metal_02 ${itemId} buffer must be ${expected}`,
    );
    assert.equal(
      DEFAULT_NPC_CONFIG_CLASS_B.targetBuffer[itemId],
      retentionDefaults[itemId],
      `comp_manuf_02 ${itemId} buffer stays retention-derived`,
    );
  }
  assert.deepEqual(
    DEFAULT_NPC_CONFIG_CLASS_B.targetBuffer,
    retentionDefaults,
    'the manufacturing NPC default is byte-identical to the retention rule',
  );
  assert.deepEqual(
    DEFAULT_NPC_CONFIG_CLASS_A.offerBatchSizes,
    { IRON_INGOT: 5, STEEL_PLATE: 4, HEAVY_ALLOY: 2 },
    'offer batch sizes are unchanged',
  );
  assert.equal(DEFAULT_NPC_CONFIG_CLASS_A.minCreditReserve, 500);
  assert.equal(DEFAULT_NPC_CONFIG_CLASS_A.offerDurationTicks, 300);
  assert.equal(DEFAULT_NPC_CONFIG_CLASS_A.maxActiveOffers, 3);
});

test('neither shared default object is mutated to obtain the exception', () => {
  assert.ok(Object.isFrozen(DEFAULT_NPC_CONFIG_CLASS_A.targetBuffer), 'class A buffer stays frozen');
  assert.ok(Object.isFrozen(DEFAULT_NPC_CONFIG_CLASS_B.targetBuffer), 'class B buffer stays frozen');
  assert.notEqual(
    DEFAULT_NPC_CONFIG_CLASS_A.targetBuffer,
    DEFAULT_NPC_CONFIG_CLASS_B.targetBuffer,
    'the two companies keep separate buffer objects',
  );
  const first = { ...DEFAULT_NPC_CONFIG_CLASS_A.targetBuffer };
  const second = { ...DEFAULT_NPC_CONFIG_CLASS_B.targetBuffer };
  new FactoryMatch({ matchId: 'match_r1_demand_defaults' }).advanceTicks(3);
  assert.deepEqual({ ...DEFAULT_NPC_CONFIG_CLASS_A.targetBuffer }, first, 'class A default is unchanged');
  assert.deepEqual({ ...DEFAULT_NPC_CONFIG_CLASS_B.targetBuffer }, second, 'class B default is unchanged');
});

test('a default match accepts a targeted R1 ingot offer from comp_metal_02', () => {
  const match = new FactoryMatch({ matchId: 'match_r1_demand_ingot' });
  const price = npcMaxBuyPrice('IRON_INGOT');
  assert.equal(price, 10, 'the ingot ceiling is the shipped R1 base unit cost');
  offerFromPlayer(match, {
    itemId: 'IRON_INGOT',
    quantity: APPROVED_INGOT_BUFFER,
    unitPriceCredits: price,
    targetBuyerId: METALLURGY_NPC,
  });
  const offer = pendingPlayerOffer(match, 'IRON_INGOT');
  assert.ok(offer, 'the offer is pending before the NPC evaluates it');

  const decided = tickUntilDecided(match, offer.contractId);
  assert.equal(
    decided.status,
    'ACTIVE',
    'the default metallurgy NPC accepts five R1 ingots at the existing price ceiling',
  );
  assert.equal(decided.buyerCompanyId, METALLURGY_NPC);
  assert.equal(decided.totalQuantity, APPROVED_INGOT_BUFFER);
  assert.equal(decided.deliveredQuantity, 0, 'acceptance alone delivers nothing');
});

test('the same default match still buys RAW_ORE and still ignores zero-buffer goods', () => {
  const oreMatch = new FactoryMatch({ matchId: 'match_r1_demand_ore' });
  offerFromPlayer(oreMatch, { itemId: 'RAW_ORE', quantity: 5, unitPriceCredits: 20 });
  const oreOffer = pendingPlayerOffer(oreMatch, 'RAW_ORE');
  assert.ok(oreOffer, 'the ore offer is pending');
  const oreDecided = tickUntilDecided(oreMatch, oreOffer.contractId);
  assert.equal(oreDecided.status, 'ACTIVE', 'unchanged ore buying still works');
  assert.equal(oreDecided.buyerCompanyId, METALLURGY_NPC);

  // STEEL_PLATE is an input of R2/R3 (so it is a "needed" item for class A), but
  // its buffer stays zero, so the approved exception grants it no new demand.
  const steelMatch = new FactoryMatch({ matchId: 'match_r1_demand_steel' });
  offerFromPlayer(steelMatch, {
    itemId: 'STEEL_PLATE',
    quantity: 4,
    unitPriceCredits: 30,
    targetBuyerId: METALLURGY_NPC,
  });
  const steelOffer = pendingPlayerOffer(steelMatch, 'STEEL_PLATE');
  assert.ok(steelOffer, 'the steel offer is pending');
  const steelDecided = tickUntilDecided(steelMatch, steelOffer.contractId);
  assert.equal(steelDecided.status, 'PENDING', 'a zero-buffer item is still not bought');
  assert.equal(steelDecided.buyerCompanyId, METALLURGY_NPC);
});

test('the NPC retains the approved ingot buffer before selling surplus', () => {
  const below = new FactoryMatch({ matchId: 'match_r1_retain_below' });
  below.engine.getCompany(METALLURGY_NPC)!.inventory.IRON_INGOT.available = APPROVED_INGOT_BUFFER + 3;
  below.advanceTicks(1);
  assert.equal(
    pendingNpcIngotOffers(below).length,
    0,
    'nine ingots are only four above the buffer: no surplus offer yet',
  );

  const atBuffer = new FactoryMatch({ matchId: 'match_r1_retain_release' });
  atBuffer.engine.getCompany(METALLURGY_NPC)!.inventory.IRON_INGOT.available =
    APPROVED_INGOT_BUFFER + 5;
  atBuffer.advanceTicks(1);
  const offers = pendingNpcIngotOffers(atBuffer);
  assert.equal(offers.length, 1, 'ten ingots leave one five-unit surplus batch');
  assert.equal(offers[0].totalQuantity, 5);
  assert.equal(
    String(atBuffer.engine.getCompany(METALLURGY_NPC)!.companyId),
    offers[0].sellerCompanyId,
  );
});

function pendingNpcIngotOffers(match: FactoryMatch): SupplyContract[] {
  return match.engine
    .getAllContracts()
    .filter(
      (contract) =>
        contract.sellerCompanyId === METALLURGY_NPC &&
        contract.itemId === 'IRON_INGOT' &&
        contract.status === 'PENDING',
    );
}

test('the manufacturing NPC keeps its zero ingot buffer and does not buy', () => {
  assert.equal(DEFAULT_NPC_CONFIG_CLASS_B.companyId, MANUFACTURING_NPC);
  const match = new FactoryMatch({ matchId: 'match_r1_manufacturing' });
  offerFromPlayer(match, {
    itemId: 'IRON_INGOT',
    quantity: APPROVED_INGOT_BUFFER,
    unitPriceCredits: npcMaxBuyPrice('IRON_INGOT'),
    targetBuyerId: MANUFACTURING_NPC,
  });
  const offer = pendingPlayerOffer(match, 'IRON_INGOT');
  assert.ok(offer, 'the offer is pending');
  const decided = tickUntilDecided(match, offer.contractId);
  assert.equal(decided.status, 'PENDING', 'the exception is limited to comp_metal_02');
});
