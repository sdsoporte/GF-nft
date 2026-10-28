/**
 * Spec S3 — credit and collateral invariants for the flows that hold today.
 *
 * Scope boundary (assumption A1 / issue #5): partial-delivery settlement on an
 * expired contract is a documented OPEN defect. The engine refunds the buyer for
 * the undelivered units and pays out the seller collateral, but the delivered
 * units are never paid to the seller, so their value leaves the ledger without a
 * declared sink. This file therefore:
 *
 * - asserts full credit conservation for the flows that hold today: creation
 *   moves no credits, acceptance locks buyer value plus seller collateral,
 *   fulfilment returns collateral and pays the seller minus the 2% market fee
 *   (the only declared sink), cancellation and partial shipment move no credits;
 * - asserts today's documented default behavior without blessing the ledger
 *   outcome, and carries a PENDING entry linked to issue #5 for the settlement
 *   assertion that must flip green when #5 lands.
 *
 * Collateral arithmetic asserted here: `collateral = floor(totalValue * 20 / 100)`
 * and `totalValue = quantity * unitPrice`, both derived from the contract terms
 * the engine records.
 *
 * Determinism: only the literal seed drives the engine (assumption A3).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import type { SimulationSnapshot, SupplyContract } from '../../src/domain/types.ts';
import {
  MANUF_A,
  MANUF_B,
  METAL_A,
  METAL_B,
  acceptOfferStep,
  buildScenarioCorpus,
  createOfferStep,
  createScenario,
  shipStep,
  runScenario,
  totalCredits,
} from './property-helpers.ts';

const INITIAL_CREDITS_PER_COMPANY = 10000;
const INITIAL_MATCH_CREDITS = INITIAL_CREDITS_PER_COMPANY * 4;

function marketFee(contract: SupplyContract): number {
  return Math.floor(
    (contract.totalValueCredits * SimulatorEngine.MARKET_TRANSACTION_FEE_BPS) / 10000,
  );
}

/**
 * Spendable credits plus everything the credit ledger still owns elsewhere:
 * escrow held by ACTIVE contracts and the fee already burned by FULFILLED ones.
 * This total is invariant for every non-defaulting contract flow.
 */
function creditBookTotal(snapshot: SimulationSnapshot): number {
  let total = totalCredits(snapshot);
  for (const contract of Object.values(snapshot.contracts)) {
    if (contract.status === 'ACTIVE') {
      total += contract.totalValueCredits + contract.collateralSellerCredits;
    } else if (contract.status === 'FULFILLED') {
      total += marketFee(contract);
    }
  }
  return total;
}

function contractsOf(snapshot: SimulationSnapshot): SupplyContract[] {
  return Object.values(snapshot.contracts);
}

/** Contract on RAW_ORE for a seller that starts the match with 200 units. */
const CONTRACT_ITEM = 'RAW_ORE' as const;

test('contract terms record quantity, value, 20% collateral and the penalty rate', () => {
  const scenario = buildScenarioCorpus().find((candidate) => candidate.seed === 777);
  assert.ok(scenario, 'partial-shipment scenario must be part of the corpus');

  let pending: SupplyContract | undefined;
  runScenario(scenario, {
    onTickEnd(_engine, tick, _before, after) {
      if (tick === 10) {
        pending = contractsOf(after)[0];
      }
    },
  });

  assert.ok(pending, 'the offer must be recorded');
  assert.equal(pending.totalQuantity, 60);
  assert.equal(pending.unitPriceCredits, 5);
  assert.equal(pending.totalValueCredits, 60 * 5);
  assert.equal(
    pending.collateralSellerCredits,
    Math.floor((pending.totalValueCredits * 20) / 100),
  );
  assert.equal(pending.penaltyPerMissingUnit, 10);
  assert.ok(pending.deadlineTick > pending.createdAtTick, 'deadline must be in the future');
});

test('acceptance locks buyer value and seller collateral, partial shipment moves none of it (seed 777)', () => {
  const scenario = buildScenarioCorpus().find((candidate) => candidate.seed === 777);
  assert.ok(scenario, 'partial-shipment scenario must be part of the corpus');

  const books: number[] = [];
  const snapshots: Record<number, SimulationSnapshot> = {};
  let finalSnapshot: SimulationSnapshot | undefined;

  const engine = runScenario(scenario, {
    onTickEnd(_engine, tick, _before, after) {
      books.push(creditBookTotal(after));
      if (tick === 10 || tick === 20 || tick === 29 || tick === 30) {
        snapshots[tick] = after;
      }
      finalSnapshot = after;
    },
  });

  const afterCreate = snapshots[10];
  const afterAccept = snapshots[20];
  const beforeShipment = snapshots[29];
  const afterShipment = snapshots[30];
  assert.ok(afterCreate && afterAccept && beforeShipment && afterShipment);
  assert.ok(finalSnapshot, 'scenario must produce snapshots');

  const createdContract = contractsOf(afterCreate)[0];
  const value = createdContract.totalValueCredits;
  const collateral = createdContract.collateralSellerCredits;

  // Creation checks collateral but locks nothing.
  assert.equal(afterCreate.companies[METAL_A].credits, INITIAL_CREDITS_PER_COMPANY);
  assert.equal(afterCreate.companies[MANUF_A].credits, INITIAL_CREDITS_PER_COMPANY);
  assert.equal(createdContract.status, 'PENDING');

  // Acceptance locks 100% of the buyer value and 20% of the seller collateral.
  assert.equal(afterAccept.companies[MANUF_A].credits, INITIAL_CREDITS_PER_COMPANY - value);
  assert.equal(afterAccept.companies[METAL_A].credits, INITIAL_CREDITS_PER_COMPANY - collateral);
  assert.equal(contractsOf(afterAccept)[0].status, 'ACTIVE');

  // Shipment moves material, not credits, and keeps escrow locked. Tick 30 also
  // starts a raw ore extraction cycle, the only source of new material.
  const shippedUnits = 20;
  const extractionThisTick = 5;
  assert.equal(
    afterShipment.companies[METAL_A].inventory[CONTRACT_ITEM].available -
      beforeShipment.companies[METAL_A].inventory[CONTRACT_ITEM].available,
    -shippedUnits + extractionThisTick,
    'the seller ships from its own stock',
  );
  assert.equal(
    afterShipment.companies[MANUF_A].inventory[CONTRACT_ITEM].available -
      beforeShipment.companies[MANUF_A].inventory[CONTRACT_ITEM].available,
    shippedUnits + extractionThisTick,
    'the buyer receives the shipped stock',
  );
  const contract = contractsOf(finalSnapshot)[0];
  assert.equal(contract.status, 'ACTIVE', 'a partial shipment leaves escrow locked');
  assert.equal(contract.deliveredQuantity, shippedUnits);
  assert.equal(contractsOf(afterShipment)[0].deliveredQuantity, shippedUnits);
  assert.equal(finalSnapshot.companies[MANUF_A].credits, INITIAL_CREDITS_PER_COMPANY - value);
  assert.equal(finalSnapshot.companies[METAL_A].credits, INITIAL_CREDITS_PER_COMPANY - collateral);

  // Credit book is invariant across creation, acceptance and shipment.
  assert.deepEqual(
    [...new Set(books)],
    [INITIAL_MATCH_CREDITS],
    'spendable plus escrowed credits must be constant while the contract is open',
  );
  assert.equal(engine.getCurrentTick(), scenario.totalTicks);
});

test('fulfilment returns collateral and pays the seller minus the market fee (seed 1234)', () => {
  const scenario = buildScenarioCorpus().find((candidate) => candidate.seed === 1234);
  assert.ok(scenario, 'full-fulfilment scenario must be part of the corpus');

  const books: number[] = [];
  let afterAccept: SimulationSnapshot | undefined;
  let afterFirstShipment: SimulationSnapshot | undefined;
  let afterFulfilment: SimulationSnapshot | undefined;

  runScenario(scenario, {
    onTickEnd(_engine, tick, _before, after) {
      books.push(creditBookTotal(after));
      if (tick === 10) afterAccept = after;
      if (tick === 20) afterFirstShipment = after;
      if (tick === 30) afterFulfilment = after;
    },
  });

  assert.ok(afterAccept && afterFirstShipment && afterFulfilment, 'scenario must capture every phase');

  const contract = contractsOf(afterAccept)[0];
  const value = contract.totalValueCredits;
  const collateral = contract.collateralSellerCredits;
  const fee = Math.floor((value * SimulatorEngine.MARKET_TRANSACTION_FEE_BPS) / 10000);
  assert.equal(value, 40 * 10);
  assert.equal(fee, 8, '2% of 400 credits');

  assert.equal(afterAccept.companies[MANUF_B].credits, INITIAL_CREDITS_PER_COMPANY - value);
  assert.equal(afterAccept.companies[METAL_B].credits, INITIAL_CREDITS_PER_COMPANY - collateral);

  // First shipment only reduces the outstanding quantity.
  assert.equal(contractsOf(afterFirstShipment)[0].status, 'ACTIVE');
  assert.equal(contractsOf(afterFirstShipment)[0].deliveredQuantity, 25);
  assert.equal(afterFirstShipment.companies[METAL_B].credits, INITIAL_CREDITS_PER_COMPANY - collateral);

  // Final shipment settles: collateral back, value minus burned fee paid out.
  const settled = contractsOf(afterFulfilment)[0];
  assert.equal(settled.status, 'FULFILLED');
  assert.equal(settled.deliveredQuantity, 40);
  assert.equal(
    afterFulfilment.companies[METAL_B].credits,
    INITIAL_CREDITS_PER_COMPANY - collateral + collateral + value - fee,
    'seller receives its collateral back plus the net payment',
  );
  assert.equal(
    afterFulfilment.companies[MANUF_B].credits,
    INITIAL_CREDITS_PER_COMPANY - value,
    'the buyer pays exactly the contract value',
  );
  assert.equal(
    totalCredits(afterFulfilment),
    INITIAL_MATCH_CREDITS - fee,
    'the market fee is the only credit sink of a fulfilled contract',
  );
  assert.equal(afterFulfilment.companies[METAL_B].reputation, 105);
  assert.equal(afterFulfilment.companies[MANUF_B].reputation, 105);

  // Book invariant: escrow/fee always account for the difference from 40,000.
  assert.deepEqual(
    [...new Set(books)],
    [INITIAL_MATCH_CREDITS],
    'spendable plus escrowed plus burned credits must stay constant',
  );
});

test('a cancelled offer releases no credits and moves the book by nothing (seed 65535)', () => {
  const scenario = buildScenarioCorpus().find((candidate) => candidate.seed === 65535);
  assert.ok(scenario, 'cancellation scenario must be part of the corpus');

  const totals: number[] = [];
  let finalSnapshot: SimulationSnapshot | undefined;

  const engine = runScenario(scenario, {
    onTickEnd(_engine, _tick, _before, after) {
      totals.push(totalCredits(after));
      finalSnapshot = after;
    },
  });

  assert.ok(finalSnapshot, 'scenario must produce snapshots');
  const contract = contractsOf(finalSnapshot)[0];
  assert.equal(contract.status, 'CANCELLED');
  assert.equal(contract.deliveredQuantity, 0);
  assert.deepEqual([...new Set(totals)], [INITIAL_MATCH_CREDITS]);
  assert.equal(engine.getCompany(METAL_A)?.credits, INITIAL_CREDITS_PER_COMPANY);
});

/**
 * Default settlement after a partial delivery. Today's documented behavior is
 * asserted; the ledger loss it leaves behind is issue #5 and stays pending.
 */
const DEFAULT_SCENARIO = createScenario({
  seed: 2024,
  label: 'partial delivery expires into a defaulted contract',
  totalTicks: 120,
  contractsEnabled: true,
  steps: [
    createOfferStep({
      sellerCompanyId: METAL_A,
      itemId: CONTRACT_ITEM,
      quantity: 100,
      unitPriceCredits: 2,
      deadlineTick: 60,
      atTick: 10,
    }),
    acceptOfferStep({ sellerCompanyId: METAL_A, buyerCompanyId: MANUF_A, atTick: 20 }),
    shipStep({ sellerCompanyId: METAL_A, quantity: 30, atTick: 30 }),
  ],
});

test('default refunds the undelivered value and caps the indemnity at the collateral (issue #5 pending)', () => {
  let beforeDefault: SimulationSnapshot | undefined;
  let afterDefault: SimulationSnapshot | undefined;

  const engine = runScenario(DEFAULT_SCENARIO, {
    onTickEnd(_engine, tick, _before, after) {
      if (tick === 60) beforeDefault = after;
      if (tick === 61) afterDefault = after;
    },
  });

  assert.ok(beforeDefault && afterDefault, 'scenario must capture both sides of the default tick');
  const contractBefore = contractsOf(beforeDefault)[0];
  assert.equal(contractBefore.status, 'ACTIVE');
  assert.equal(contractBefore.deliveredQuantity, 30);

  const contract = contractsOf(afterDefault)[0];
  assert.equal(contract.status, 'DEFAULTED', 'expiry defaults an under-delivered contract');
  assert.equal(contract.settledAtTick, 61, 'settlement happens on the first tick past the deadline');

  const missingUnits = contract.totalQuantity - contract.deliveredQuantity;
  const undeliveredValue = missingUnits * contract.unitPriceCredits;
  const penalty = missingUnits * contract.penaltyPerMissingUnit;
  const indemnity = Math.min(contract.collateralSellerCredits, penalty);
  assert.equal(missingUnits, 70);
  assert.equal(undeliveredValue, 140);
  assert.equal(penalty, 700);
  assert.equal(indemnity, contract.collateralSellerCredits, 'the penalty exceeds the collateral here');

  const buyerBefore = beforeDefault.companies[MANUF_A];
  const buyerAfter = afterDefault.companies[MANUF_A];
  assert.equal(
    buyerAfter.credits - buyerBefore.credits,
    undeliveredValue + indemnity,
    'the buyer is refunded the undelivered value and indemnified from the collateral',
  );

  const sellerBefore = beforeDefault.companies[METAL_A];
  const sellerAfter = afterDefault.companies[METAL_A];
  assert.equal(
    sellerAfter.credits - sellerBefore.credits,
    contract.collateralSellerCredits - indemnity,
    'the seller only gets back the collateral the penalty did not consume',
  );
  assert.equal(sellerAfter.reputation, sellerBefore.reputation - 15, 'the seller is penalised');

  for (const company of Object.values(afterDefault.companies)) {
    assert.ok(company.credits >= 0, `${company.companyId} credits must never go negative`);
  }
  assert.equal(engine.getCurrentTick(), DEFAULT_SCENARIO.totalTicks);
});

// Issue #5 (`[P0][Economía] Ledger de créditos en entrega parcial`) is still open:
// today the delivered units are never paid to the seller and their value vanishes
// without a declared sink (40,000 -> 39,940 for the scenario above, i.e. the 30
// delivered units x 2 credits). This entry flips to an asserted test when the fix
// lands; it must not be reported as green coverage before then.
test.todo(
  'partial-delivery default pays the seller for delivered units and conserves total credits (issue #5)',
);
