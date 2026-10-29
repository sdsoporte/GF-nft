import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeCreditAccountRef, type CreditLedgerOpening, type CreditLedgerMovement } from '../../src/domain/creditLedger.ts';
import type { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import { BUYER, SELLER, OUTSIDER_A, ContractDriver, createAcceptedContract, companyOf, contractOf, expectRejected } from './contracts-helpers.ts';

type Journal = { opening: CreditLedgerOpening; movements: CreditLedgerMovement[] };
function journalOf(engine: SimulatorEngine): Journal {
  const read = Reflect.get(engine, 'getCreditLedger');
  assert.equal(typeof read, 'function', 'economic movement evidence must have a public read surface');
  return read.call(engine) as Journal;
}
function reconciles(engine: SimulatorEngine): void {
  const { opening, movements } = journalOf(engine);
  const accounts = new Map(opening.balances.map(({ account, balanceCredits }) => [encodeCreditAccountRef(account), balanceCredits]));
  for (const [index, movement] of movements.entries()) {
    assert.equal(movement.sequence, index + 1);
    assert.ok(Number.isSafeInteger(movement.amountCredits) && movement.amountCredits > 0);
    const source = encodeCreditAccountRef(movement.source);
    const destination = encodeCreditAccountRef(movement.destination);
    accounts.set(source, (accounts.get(source) ?? 0) - movement.amountCredits);
    accounts.set(destination, (accounts.get(destination) ?? 0) + movement.amountCredits);
    assert.ok(accounts.get(source)! >= 0, 'no account may pay money it does not hold');
  }
  assert.equal(new Set(movements.map((entry) => entry.eventKey)).size, movements.length);
  const active = engine.getAllContracts().filter((contract) => contract.status === 'ACTIVE');
  for (const company of engine.getAllCompanies()) {
    for (const [kind, expected] of [
      ['AVAILABLE', company.credits],
      ['BUYER_ESCROW', active.filter((contract) => contract.buyerCompanyId === company.companyId).reduce((sum, contract) => sum + contract.totalValueCredits, 0)],
      ['SELLER_COLLATERAL', active.filter((contract) => contract.sellerCompanyId === company.companyId).reduce((sum, contract) => sum + contract.collateralSellerCredits, 0)],
    ] as const) {
      assert.equal(accounts.get(encodeCreditAccountRef({ kind, companyId: company.companyId })) ?? 0, expected);
    }
  }
  const initial = opening.balances.reduce((sum, account) => sum + account.balanceCredits, 0);
  assert.equal([...accounts.values()].reduce((sum, balance) => sum + balance, 0), initial);
}
test('real full, partial and zero delivery movements reconcile every available/held account and declared sink', () => {
  for (const delivered of [10, 4, 0]) {
    const { driver, engine, contractId } = createAcceptedContract({ quantity: 10, unitPriceCredits: 50, deadlineTicks: 8, sellerStock: 10 });
    reconciles(engine);
    if (delivered) { driver.ship(SELLER, contractId, delivered); driver.run(1); }
    driver.run(9 - driver.tick);
    reconciles(engine);
    assert.equal(contractOf(engine, contractId).status, delivered === 10 ? 'FULFILLED' : 'DEFAULTED');
    const journal = journalOf(engine);
    assert.equal(journal.opening.coverage, 'COMPLETE');
    assert.equal(journal.opening.observedAtTick, 0);
    const deliveredValue = delivered * 50, fee = Math.floor(deliveredValue * 0.02);
    assert.equal(journal.movements.filter((entry) => entry.kind === 'FEE_SINK').reduce((sum, entry) => sum + entry.amountCredits, 0), fee);
    assert.equal(journal.movements.filter((entry) => entry.kind === 'DELIVERY_PAYMENT').reduce((sum, entry) => sum + entry.amountCredits, 0), deliveredValue - fee);
    const settled = journalOf(engine);
    driver.run(2);
    assert.deepEqual(journalOf(engine), settled, 'closed contracts never pay twice');
  }
});
test('the first post-deadline dispatch changes no goods/energy and matches ordinary expiry', () => {
  const make = () => createAcceptedContract({ quantity: 10, unitPriceCredits: 50, deadlineTicks: 6, sellerStock: 10 });
  const late = make(), control = make();
  late.driver.run(4); control.driver.run(4);
  const commandId = late.driver.ship(SELLER, late.contractId, 4);
  late.driver.run(1); control.driver.run(1);
  const rejected = expectRejected(late.engine, commandId, 'ERR_CONTRACT_NOT_ACTIVE');
  assert.equal(rejected.errorMessage, 'Target contract is not active');
  assert.deepEqual(late.engine.createSnapshot().companies, control.engine.createSnapshot().companies);
  assert.deepEqual(late.engine.getAllContracts(), control.engine.getAllContracts());
  assert.equal(contractOf(late.engine, late.contractId).deliveredQuantity, 0);
  reconciles(late.engine);
});
test('competing acceptances and permanent-key retry record escrow and collateral only once', () => {
  const driver = new ContractDriver(), engine = driver.engine;
  driver.createOffer(SELLER, { itemId: 'STEEL_PLATE', quantity: 10, unitPriceCredits: 50, deadlineTicks: 8 });
  driver.run(1);
  const id = engine.getAllContracts()[0].contractId;
  driver.acceptOffer(BUYER, id); driver.acceptOffer(OUTSIDER_A, id);
  const first = engine.getCommandQueue().listPending()[0];
  const counter = engine.getCommandQueue().getSequenceCounter();
  assert.equal(engine.submitCommand(first), false);
  assert.equal(engine.getCommandQueue().getSequenceCounter(), counter);
  driver.run(1);
  assert.equal(engine.getExecutionHistory().filter((entry) => entry.success).length, 2);
  assert.deepEqual(journalOf(engine).movements.map((entry) => entry.kind), ['BUYER_ESCROW_DEPOSIT', 'SELLER_COLLATERAL_DEPOSIT']);
  reconciles(engine);
});
test('maintenance journals the actual shortfall payment without changing legacy pause/reputation rules', () => {
  const { engine } = new ContractDriver();
  const companies = structuredClone(engine.getAllCompanies());
  const seller = companies.find((company) => company.companyId === SELLER)!;
  seller.credits = 80; seller.lines[0].status = 'RUNNING'; seller.lines[1].status = 'NO_ENERGY';
  engine.hydrate({ currentTick: 299, companies });
  engine.processTick();
  assert.equal(companyOf(engine, SELLER).credits, 0);
  assert.equal(companyOf(engine, SELLER).reputation, 95);
  assert.equal(companyOf(engine, SELLER).lines[0].status, 'PAUSED');
  assert.equal(companyOf(engine, SELLER).lines[1].status, 'NO_ENERGY');
  assert.equal(companyOf(engine, SELLER).maintenancePaidTicks, 0);
  assert.deepEqual(journalOf(engine).movements.map((entry) => [entry.kind, entry.amountCredits]), [['MAINTENANCE_SINK', 80]]);
  reconciles(engine);
});
test('checkpoint rollback and detached reads include every new journal record and sequence', () => {
  const { driver, engine, contractId } = createAcceptedContract({ quantity: 10, unitPriceCredits: 50, deadlineTicks: 8, sellerStock: 10 });
  const before = journalOf(engine), checkpoint = engine.createCheckpoint();
  driver.ship(SELLER, contractId, 10); driver.run(1);
  assert.ok(journalOf(engine).movements.length > before.movements.length);
  engine.restoreCheckpoint(checkpoint);
  assert.deepEqual(journalOf(engine), before);
  const detached = journalOf(engine);
  Reflect.set(detached.movements[0], 'source', { kind: 'AVAILABLE', companyId: 'not-owned' });
  Reflect.set(detached.opening.balances[0], 'balanceCredits', 0);
  assert.deepEqual(journalOf(engine), before);
});
