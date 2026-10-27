/**
 * Supply-contract lifecycle: creation, acceptance, partial delivery and
 * fulfillment (T3, spec S2 "contratos y vencimientos").
 *
 * Every scenario drives the authoritative engine through public APIs only:
 * `submitCommand`, `processTick`, `getCompany`, `getContract`,
 * `getAllContracts` and `getExecutionHistory`.
 *
 * Open P0 defect #4 (acceptance overwrites `buyerCompanyId` without validating
 * `targetBuyerId`, and self-dealing is not policed) is NOT asserted as correct
 * behavior. Those two scenarios are explicit pending tests that assert the
 * expected behavior and stay skipped until issue #4 lands its fix.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUYER,
  OUTSIDER_A,
  OUTSIDER_B,
  SELLER,
  ContractDriver,
  companyOf,
  contractOf,
  createAcceptedContract,
  createEngine,
  expectExecuted,
  expectRejected,
  executionResult,
  setStock,
} from './contracts-helpers.ts';

test('creating an open offer stores a pending contract with 20% collateral and no escrow', () => {
  const driver = new ContractDriver();
  const { engine } = driver;
  const seller = companyOf(engine, SELLER);

  const commandId = driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 40,
    unitPriceCredits: 25,
    deadlineTicks: 100,
  });
  driver.run(1);

  expectExecuted(engine, commandId);

  const contracts = engine.getAllContracts();
  assert.equal(contracts.length, 1);

  const contract = contracts[0];
  assert.equal(contract.status, 'PENDING');
  assert.equal(contract.sellerCompanyId, SELLER);
  // No target buyer requested: an open offer is not assigned yet.
  assert.equal(contract.buyerCompanyId, '');
  assert.equal(contract.itemId, 'STEEL_PLATE');
  assert.equal(contract.totalQuantity, 40);
  assert.equal(contract.deliveredQuantity, 0);
  assert.equal(contract.unitPriceCredits, 25);
  assert.equal(contract.totalValueCredits, 1000);
  assert.equal(contract.collateralSellerCredits, 200); // floor(20% of 1000)
  assert.equal(contract.penaltyPerMissingUnit, 10);
  assert.equal(contract.createdAtTick, 1);
  assert.equal(contract.deadlineTick, 100);
  assert.equal(contract.settledAtTick, undefined);
  // Creation only checks the 20% collateral; it locks nothing yet.
  assert.equal(seller.credits, 10000);
});

test('a targeted offer records the intended buyer while it stays pending', () => {
  const driver = new ContractDriver();
  const { engine } = driver;

  const commandId = driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 100,
    targetBuyerId: BUYER,
  });
  driver.run(1);

  expectExecuted(engine, commandId);

  const contract = engine.getAllContracts()[0];
  assert.equal(contract.status, 'PENDING');
  assert.equal(contract.buyerCompanyId, BUYER);
  assert.equal(contract.deliveredQuantity, 0);
});

test('offer creation rejects non-positive quantities and a non-future deadline', () => {
  const driver = new ContractDriver();
  const { engine } = driver;

  const zeroQuantity = driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 0,
    unitPriceCredits: 25,
    deadlineTicks: 100,
  });
  const zeroPrice = driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 10,
    unitPriceCredits: 0,
    deadlineTicks: 100,
  });
  // All three commands execute on tick 1, so a deadline of tick 1 is not in
  // the future and must be rejected.
  const deadlineNow = driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 10,
    unitPriceCredits: 25,
    deadlineTicks: 1,
  });
  driver.run(1);

  expectRejected(engine, zeroQuantity, 'ERR_INVALID_OFFER_PARAMS');
  expectRejected(engine, zeroPrice, 'ERR_INVALID_OFFER_PARAMS');
  expectRejected(engine, deadlineNow, 'ERR_INVALID_OFFER_PARAMS');
  assert.equal(engine.getAllContracts().length, 0);
});

test('offer creation rejects a seller that cannot cover the 20% collateral', () => {
  const driver = new ContractDriver();
  const { engine } = driver;
  // 100 CREDITS cannot cover the 200 CREDITS collateral of a 1000 CREDITS offer.
  companyOf(engine, SELLER).credits = 100;

  const commandId = driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 100,
    unitPriceCredits: 10,
    deadlineTicks: 100,
  });
  driver.run(1);

  expectRejected(engine, commandId, 'ERR_INSUFFICIENT_COLLATERAL');
  assert.equal(engine.getAllContracts().length, 0);
  assert.equal(companyOf(engine, SELLER).credits, 100);
});

test('accepting an offer locks buyer escrow and seller collateral and activates it', () => {
  const { driver, engine, contractId } = createAcceptedContract({
    quantity: 40,
    unitPriceCredits: 25,
    deadlineTicks: 100,
  });

  const contract = contractOf(engine, contractId);
  assert.equal(contract.status, 'ACTIVE');
  assert.equal(contract.buyerCompanyId, BUYER);
  assert.equal(contract.deliveredQuantity, 0);
  assert.equal(contract.settledAtTick, undefined);

  // 100% of the contract value is escrowed from the buyer.
  assert.equal(companyOf(engine, BUYER).credits, 9000);
  // 20% collateral is locked from the seller.
  assert.equal(companyOf(engine, SELLER).credits, 9800);
  // No reputation movement happens before settlement.
  assert.equal(companyOf(engine, BUYER).reputation, 100);
  assert.equal(companyOf(engine, SELLER).reputation, 100);
  assert.equal(driver.tick, 2);
});

test('an open offer is assigned to the company that accepts it', () => {
  const engine = createEngine();
  const driver = new ContractDriver(engine);

  driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 40,
    unitPriceCredits: 25,
    deadlineTicks: 100,
  });
  driver.run(1);
  const contractId = engine.getAllContracts()[0].contractId;

  const acceptId = driver.acceptOffer(OUTSIDER_B, contractId);
  driver.run(1);

  expectExecuted(engine, acceptId);
  const contract = contractOf(engine, contractId);
  assert.equal(contract.status, 'ACTIVE');
  assert.equal(contract.buyerCompanyId, OUTSIDER_B);
  assert.equal(companyOf(engine, OUTSIDER_B).credits, 9000);
  assert.equal(companyOf(engine, BUYER).credits, 10000);
});

test('a targeted offer cannot be accepted by a non-targeted company (issue #4)', {
  skip: 'issue #4 is open: ACCEPT_SUPPLY_OFFER overwrites buyerCompanyId without validating targetBuyerId',
}, () => {
  const engine = createEngine();
  const driver = new ContractDriver(engine);

  driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 40,
    unitPriceCredits: 25,
    deadlineTicks: 100,
    targetBuyerId: BUYER,
  });
  driver.run(1);
  const contractId = engine.getAllContracts()[0].contractId;

  // Expected behavior once issue #4 is fixed: a company that is not the
  // target must not be able to hijack the offer.
  const hijackId = driver.acceptOffer(OUTSIDER_B, contractId);
  driver.run(1);

  assert.equal(executionResult(engine, hijackId).success, false);
  const contract = contractOf(engine, contractId);
  assert.equal(contract.status, 'PENDING');
  assert.equal(contract.buyerCompanyId, BUYER);
  assert.equal(companyOf(engine, OUTSIDER_B).credits, 10000);
});

test('a seller cannot accept its own offer (issue #4)', {
  skip: 'issue #4 is open: self-dealing is not policed, the seller can accept its own offer',
}, () => {
  const engine = createEngine();
  const driver = new ContractDriver(engine);

  driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 100,
  });
  driver.run(1);
  const contractId = engine.getAllContracts()[0].contractId;

  // Expected behavior once issue #4 is fixed: self-dealing must be rejected.
  const selfAcceptId = driver.acceptOffer(SELLER, contractId);
  driver.run(1);

  assert.equal(executionResult(engine, selfAcceptId).success, false);
  const contract = contractOf(engine, contractId);
  assert.equal(contract.status, 'PENDING');
  assert.equal(contract.buyerCompanyId, '');
  assert.equal(companyOf(engine, SELLER).credits, 10000);
});

test('acceptance is rejected when the buyer cannot fund the escrow', () => {
  const engine = createEngine();
  const driver = new ContractDriver(engine);

  driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 10,
    unitPriceCredits: 100,
    deadlineTicks: 100,
  });
  driver.run(1);
  const contractId = engine.getAllContracts()[0].contractId;

  companyOf(engine, BUYER).credits = 999; // one credit short of the 1000 escrow
  const acceptId = driver.acceptOffer(BUYER, contractId);
  driver.run(1);

  expectRejected(engine, acceptId, 'ERR_INSUFFICIENT_BUYER_FUNDS');
  assert.equal(contractOf(engine, contractId).status, 'PENDING');
  assert.equal(companyOf(engine, BUYER).credits, 999);
  assert.equal(companyOf(engine, SELLER).credits, 10000);
});

test('acceptance is rejected when the seller can no longer lock the collateral', () => {
  const engine = createEngine();
  const driver = new ContractDriver(engine);

  driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 10,
    unitPriceCredits: 100,
    deadlineTicks: 100,
  });
  driver.run(1);
  const contractId = engine.getAllContracts()[0].contractId;

  companyOf(engine, SELLER).credits = 150; // below the 200 CREDITS collateral
  const acceptId = driver.acceptOffer(BUYER, contractId);
  driver.run(1);

  expectRejected(engine, acceptId, 'ERR_INSUFFICIENT_SELLER_COLLATERAL');
  assert.equal(contractOf(engine, contractId).status, 'PENDING');
  assert.equal(companyOf(engine, BUYER).credits, 10000);
  assert.equal(companyOf(engine, SELLER).credits, 150);
});

test('an already active contract cannot be accepted a second time', () => {
  const { driver, engine, contractId } = createAcceptedContract({
    quantity: 40,
    unitPriceCredits: 25,
    deadlineTicks: 100,
  });

  const secondAcceptId = driver.acceptOffer(OUTSIDER_B, contractId);
  driver.run(1);

  expectRejected(engine, secondAcceptId, 'ERR_OFFER_NOT_AVAILABLE');
  const contract = contractOf(engine, contractId);
  assert.equal(contract.status, 'ACTIVE');
  assert.equal(contract.buyerCompanyId, BUYER);
  assert.equal(companyOf(engine, OUTSIDER_B).credits, 10000);
  assert.equal(companyOf(engine, BUYER).credits, 9000);
});

test('partial delivery ships goods to the buyer and keeps the contract active', () => {
  const { driver, engine, contractId } = createAcceptedContract({
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 200,
    sellerStock: 8,
  });

  const shipId = driver.ship(SELLER, contractId, 5);
  driver.run(1);

  expectExecuted(engine, shipId);
  const contract = contractOf(engine, contractId);
  assert.equal(contract.deliveredQuantity, 5);
  assert.equal(contract.status, 'ACTIVE');
  assert.equal(contract.settledAtTick, undefined);

  assert.equal(companyOf(engine, SELLER).inventory.STEEL_PLATE.available, 3);
  assert.equal(companyOf(engine, BUYER).inventory.STEEL_PLATE.available, 5);

  // Escrow and collateral stay locked until the contract settles.
  assert.equal(companyOf(engine, SELLER).credits, 9900);
  assert.equal(companyOf(engine, BUYER).credits, 9500);
  assert.equal(companyOf(engine, SELLER).reputation, 100);
  assert.equal(companyOf(engine, BUYER).reputation, 100);
});

test('delivering the remaining quantity fulfills, returns collateral and pays net of the 2% fee', () => {
  const { driver, engine, contractId } = createAcceptedContract({
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 200,
    sellerStock: 10,
  });

  driver.ship(SELLER, contractId, 5);
  driver.run(1);

  // Ask for more than the remaining 5 units: dispatch is capped at the
  // outstanding quantity instead of over-shipping.
  const finalShipId = driver.ship(SELLER, contractId, 20);
  driver.run(1);

  expectExecuted(engine, finalShipId);
  const contract = contractOf(engine, contractId);
  assert.equal(contract.deliveredQuantity, 10);
  assert.equal(contract.status, 'FULFILLED');
  assert.equal(contract.settledAtTick, 4);

  assert.equal(companyOf(engine, SELLER).inventory.STEEL_PLATE.available, 0);
  assert.equal(companyOf(engine, BUYER).inventory.STEEL_PLATE.available, 10);

  // Seller: 9900 locked-state + 100 collateral returned + (500 - 10 fee).
  assert.equal(companyOf(engine, SELLER).credits, 10490);
  assert.equal(companyOf(engine, BUYER).credits, 9500);
  // The only credits leaving the two companies are the 2% market fee.
  assert.equal(
    companyOf(engine, SELLER).credits + companyOf(engine, BUYER).credits,
    20000 - 10,
  );

  // Both sides gain reputation for a settled contract.
  assert.equal(companyOf(engine, SELLER).reputation, 105);
  assert.equal(companyOf(engine, BUYER).reputation, 105);
});

test('only the seller may dispatch goods for an active contract', () => {
  const { driver, engine, contractId } = createAcceptedContract({
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 200,
    sellerStock: 10,
  });

  const buyerShipId = driver.ship(BUYER, contractId, 5);
  const outsiderShipId = driver.ship(OUTSIDER_A, contractId, 5);
  driver.run(1);

  expectRejected(engine, buyerShipId, 'ERR_UNAUTHORIZED_DISPATCH');
  expectRejected(engine, outsiderShipId, 'ERR_UNAUTHORIZED_DISPATCH');

  const contract = contractOf(engine, contractId);
  assert.equal(contract.deliveredQuantity, 0);
  assert.equal(contract.status, 'ACTIVE');
  assert.equal(companyOf(engine, SELLER).inventory.STEEL_PLATE.available, 10);
  assert.equal(companyOf(engine, BUYER).inventory.STEEL_PLATE.available, 0);
});

test('dispatch is rejected for a pending offer and for insufficient stock', () => {
  const engine = createEngine();
  const driver = new ContractDriver(engine);

  driver.createOffer(SELLER, {
    itemId: 'STEEL_PLATE',
    quantity: 10,
    unitPriceCredits: 50,
    deadlineTicks: 200,
  });
  driver.run(1);
  const contractId = engine.getAllContracts()[0].contractId;

  const pendingShipId = driver.ship(SELLER, contractId, 5);
  driver.run(1);

  expectRejected(engine, pendingShipId, 'ERR_CONTRACT_NOT_ACTIVE');
  assert.equal(contractOf(engine, contractId).deliveredQuantity, 0);

  // Accept, then try to ship more than the seller actually holds.
  driver.acceptOffer(BUYER, contractId);
  driver.run(1);
  setStock(engine, SELLER, 'STEEL_PLATE', 2);

  const shortStockId = driver.ship(SELLER, contractId, 5);
  driver.run(1);

  expectRejected(engine, shortStockId, 'ERR_INSUFFICIENT_STOCK');
  assert.equal(contractOf(engine, contractId).deliveredQuantity, 0);
  assert.equal(companyOf(engine, SELLER).inventory.STEEL_PLATE.available, 2);
  assert.equal(companyOf(engine, BUYER).inventory.STEEL_PLATE.available, 0);
});
