import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUYER,
  SELLER,
  ContractDriver,
  companyOf,
  contractOf,
  expectExecuted,
  expectRejected,
  setStock,
} from './contracts-helpers.ts';

function economicState(driver: ContractDriver) {
  return structuredClone({
    companies: [SELLER, BUYER].map((id) => {
      const company = companyOf(driver.engine, id);
      return {
        companyId: id,
        credits: company.credits,
        inventory: company.inventory,
        reputation: company.reputation,
      };
    }),
    contracts: driver.engine.getAllContracts(),
    ledger: driver.engine.getCreditLedger(),
  });
}

test('acceptance at or after the offer deadline changes no economic state', () => {
  for (const executionTick of [2, 3]) {
    const driver = new ContractDriver();
    driver.createOffer(SELLER, {
      itemId: 'IRON_INGOT', quantity: 5, unitPriceCredits: 10,
      deadlineTicks: 2, targetBuyerId: BUYER,
    });
    driver.run(executionTick - 1);
    const offer = driver.engine.getAllContracts()[0];
    assert.equal(offer.status, 'PENDING');
    const before = economicState(driver);
    const historyLength = driver.engine.getExecutionHistory().length;

    const commandId = driver.acceptOffer(BUYER, offer.contractId);
    driver.run(1);

    const result = expectRejected(driver.engine, commandId, 'ERR_OFFER_NOT_AVAILABLE');
    assert.equal(result.errorMessage, 'Offer has expired');
    assert.equal(result.executedAtTick, executionTick);
    assert.deepEqual(economicState(driver), before);
    assert.equal(driver.engine.getExecutionHistory().length, historyLength + 1);
  }
});

test('acceptance before expiry still permits delivery on the deadline tick', () => {
  const driver = new ContractDriver();
  setStock(driver.engine, SELLER, 'IRON_INGOT', 5);
  driver.createOffer(SELLER, {
    itemId: 'IRON_INGOT', quantity: 5, unitPriceCredits: 10,
    deadlineTicks: 3, targetBuyerId: BUYER,
  });
  driver.run(1);
  const offer = driver.engine.getAllContracts()[0];

  const acceptance = driver.acceptOffer(BUYER, offer.contractId);
  driver.run(1);
  expectExecuted(driver.engine, acceptance);
  assert.equal(contractOf(driver.engine, offer.contractId).status, 'ACTIVE');
  assert.equal(companyOf(driver.engine, BUYER).credits, 9950);
  assert.equal(companyOf(driver.engine, SELLER).credits, 9990);

  const dispatch = driver.ship(SELLER, offer.contractId, 5);
  driver.run(1);
  expectExecuted(driver.engine, dispatch);
  const completed = contractOf(driver.engine, offer.contractId);
  assert.equal(completed.status, 'FULFILLED');
  assert.equal(completed.deliveredQuantity, 5);
  assert.equal(completed.settledAtTick, 3);
  assert.equal(companyOf(driver.engine, SELLER).inventory.IRON_INGOT.available, 0);
  assert.equal(companyOf(driver.engine, BUYER).inventory.IRON_INGOT.available, 5);
  assert.equal(companyOf(driver.engine, BUYER).credits, 9950);
  assert.equal(companyOf(driver.engine, SELLER).credits, 10049);
});
