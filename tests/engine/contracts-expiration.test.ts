/**
 * Supply-contract expiration ("vencimientos") and default resolution (T3, spec
 * S2). Scenarios drive the authoritative engine through public APIs only and
 * assert current behavior at exact tick boundaries.
 *
 * Open P0 defect #5 (credit conservation on partial delivery/settlement) is NOT
 * asserted as correct behavior: the seller-side payout for already delivered
 * units and the total credit conservation of a partial default are explicit
 * pending tests that stay skipped until issue #5 lands its fix.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUYER,
  SELLER,
  ContractDriver,
  companyOf,
  contractOf,
  createAcceptedContract,
  expectExecuted,
  expectRejected,
  setStock,
} from './contracts-helpers.ts';

interface DefaultScenario {
  readonly driver: ContractDriver;
  readonly engine: ReturnType<typeof createAcceptedContract>['engine'];
  readonly contractId: string;
}

/**
 * 10 units at 50 CREDITS = 500 escrowed; 100 CREDITS seller collateral.
 * The offer executes on tick 1, the acceptance on tick 2.
 */
function acceptUndeliveredContract(deadlineTicks: number): DefaultScenario {
  return createAcceptedContract({ quantity: 10, unitPriceCredits: 50, deadlineTicks });
}

/** Same contract, but 4 of the 10 units are shipped before the deadline. */
function partialDeliveryThenDeadline(): DefaultScenario {
  const fixture = createAcceptedContract({
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 8,
    sellerStock: 10,
  });

  fixture.driver.ship(SELLER, fixture.contractId, 4);
  fixture.driver.run(1); // tick 3: partial delivery executes
  assert.equal(contractOf(fixture.engine, fixture.contractId).deliveredQuantity, 4);

  return fixture;
}

test('a contract past its deadline defaults and refunds the undelivered escrow', () => {
  const { driver, engine, contractId } = acceptUndeliveredContract(6);

  // Deadline tick 6 is inclusive: the contract stays active while it can still
  // be delivered on time.
  driver.run(4);
  assert.equal(driver.tick, 6);
  assert.equal(contractOf(engine, contractId).status, 'ACTIVE');
  assert.equal(contractOf(engine, contractId).settledAtTick, undefined);

  driver.run(1); // tick 7: first tick strictly after the deadline
  const contract = contractOf(engine, contractId);
  assert.equal(driver.tick, 7);
  assert.equal(contract.status, 'DEFAULTED');
  assert.equal(contract.settledAtTick, 7);
  assert.equal(contract.deliveredQuantity, 0);

  // Escrow fully refunded (500) plus collateral-backed indemnity capped by the
  // 10 CREDITS per missing unit penalty (10 * 10 = 100 = full collateral).
  assert.equal(companyOf(engine, BUYER).credits, 10100);
  // Seller forfeits the whole collateral and keeps the rest.
  assert.equal(companyOf(engine, SELLER).credits, 9900);
  assert.equal(companyOf(engine, BUYER).credits + companyOf(engine, SELLER).credits, 20000);

  // Only the seller loses reputation; the buyer is not penalized.
  assert.equal(companyOf(engine, SELLER).reputation, 85);
  assert.equal(companyOf(engine, BUYER).reputation, 100);

  // Settlement is a single event: later ticks keep the same settlement tick
  // and never move credits again.
  driver.run(3);
  assert.equal(contractOf(engine, contractId).settledAtTick, 7);
  assert.equal(companyOf(engine, BUYER).credits, 10100);
  assert.equal(companyOf(engine, SELLER).credits, 9900);
});

test('a delivery executed on the deadline tick still fulfills the contract', () => {
  const { driver, engine, contractId } = createAcceptedContract({
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 6,
    sellerStock: 10,
  });

  driver.run(3); // tick 5
  assert.equal(driver.tick, 5);

  // Commands execute before the contract lifecycle step, so a dispatch
  // scheduled on the deadline tick settles before expiry is evaluated.
  driver.ship(SELLER, contractId, 10);
  driver.run(1); // tick 6 == deadlineTick
  const contract = contractOf(engine, contractId);
  assert.equal(driver.tick, 6);
  assert.equal(contract.deliveredQuantity, 10);
  assert.equal(contract.status, 'FULFILLED');
  assert.equal(contract.settledAtTick, 6);

  // Seller: 9900 locked-state + 100 collateral + (500 - 10 market fee).
  assert.equal(companyOf(engine, SELLER).credits, 10490);
  assert.equal(companyOf(engine, BUYER).credits, 9500);
  assert.equal(companyOf(engine, SELLER).reputation, 105);
  assert.equal(companyOf(engine, BUYER).reputation, 105);

  // Crossing the deadline afterwards must not re-open or re-settle anything.
  driver.run(5); // ticks 7..11
  assert.equal(contractOf(engine, contractId).status, 'FULFILLED');
  assert.equal(contractOf(engine, contractId).settledAtTick, 6);
  assert.equal(companyOf(engine, SELLER).credits, 10490);
  assert.equal(companyOf(engine, BUYER).credits, 9500);
});

test('a defaulted contract rejects further dispatch attempts', () => {
  const { driver, engine, contractId } = acceptUndeliveredContract(6);

  driver.run(5); // tick 7: defaulted
  assert.equal(contractOf(engine, contractId).status, 'DEFAULTED');

  const lateShipId = driver.ship(SELLER, contractId, 5);
  driver.run(1);

  expectRejected(engine, lateShipId, 'ERR_CONTRACT_NOT_ACTIVE');
  assert.equal(contractOf(engine, contractId).deliveredQuantity, 0);
  assert.equal(contractOf(engine, contractId).status, 'DEFAULTED');
  assert.equal(companyOf(engine, BUYER).inventory.STEEL_PLATE.available, 0);
});

test('a partial default refunds the outstanding value and indemnifies the buyer', () => {
  const { driver, engine, contractId } = partialDeliveryThenDeadline();

  driver.run(6); // ticks 4..9: default on the first tick after deadline 8
  const contract = contractOf(engine, contractId);
  assert.equal(driver.tick, 9);
  assert.equal(contract.status, 'DEFAULTED');
  assert.equal(contract.settledAtTick, 9);
  assert.equal(contract.deliveredQuantity, 4);

  // Missing 6 units: 300 CREDITS refunded plus 60 CREDITS penalty indemnity,
  // capped by the 100 CREDITS collateral.
  assert.equal(companyOf(engine, BUYER).credits, 9860);
  // Seller loses reputation and receives the collateral that the indemnity did
  // not consume (100 - 60 = 40).
  assert.equal(companyOf(engine, SELLER).reputation, 85);
  assert.ok(
    companyOf(engine, SELLER).credits >= 9940,
    'seller keeps the unspent collateral; the exact total is pending issue #5',
  );

  // Goods already shipped stay with the buyer and never return to the seller.
  assert.equal(companyOf(engine, BUYER).inventory.STEEL_PLATE.available, 4);
  assert.equal(companyOf(engine, SELLER).inventory.STEEL_PLATE.available, 6);
});

test('a partial default pays the seller for the units it already delivered (issue #5)', {
  skip: 'issue #5 is open: default settlement never pays the seller for delivered units',
}, () => {
  const { driver, engine, contractId } = partialDeliveryThenDeadline();

  driver.run(6);
  assert.equal(contractOf(engine, contractId).status, 'DEFAULTED');

  // Expected behavior once issue #5 is fixed: the 4 delivered units (4 * 50 =
  // 200 CREDITS) are paid out of the escrow at settlement.
  // 9900 locked-state + 40 returned collateral + 200 delivered value.
  assert.equal(companyOf(engine, SELLER).credits, 10140);
  assert.equal(companyOf(engine, BUYER).credits, 9860);
});

test('a partial default conserves total credits between both companies (issue #5)', {
  skip: 'issue #5 is open: credit conservation breaks on partial delivery plus settlement',
}, () => {
  const { driver, engine, contractId } = partialDeliveryThenDeadline();

  driver.run(6);
  assert.equal(contractOf(engine, contractId).status, 'DEFAULTED');

  // Both companies start at 10,000 and no other credit flow happens in this
  // scenario (no production, so no maintenance fee before tick 300).
  const total = companyOf(engine, SELLER).credits + companyOf(engine, BUYER).credits;
  assert.equal(total, 20000);
});
