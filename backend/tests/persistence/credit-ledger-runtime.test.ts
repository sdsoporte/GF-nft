import assert from 'node:assert/strict';
import test from 'node:test';
import { FactoryMatch } from '../../src/match.ts';
import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import type { MatchStore } from '../../src/persistence/matchStore.ts';
import { ContractDriver, SELLER, BUYER } from '../engine/contracts-helpers.ts';
import { MATCH_ID, sampleMetadata, withMatchStore } from './queue-fixtures.ts';
import { admitThroughStore } from './recovery-fixtures.ts';
import { CORE_STATE_TABLES, snapshotState } from './repos-fixtures.ts';

function accept(match: FactoryMatch, store: MatchStore): string {
  admitThroughStore(match, store, {
    commandId: 'cmd_live_offer', companyId: SELLER, scheduledTick: 1,
    idempotencyKey: 'live:offer', type: 'CREATE_SUPPLY_OFFER',
    targetBuyerId: BUYER, itemId: 'RAW_ORE', quantity: 10,
    unitPriceCredits: 50, deadlineTicks: 8,
  }, 'live-offer');
  match.advanceTicks(1);
  const id = match.engine.getAllContracts()[0].contractId;
  admitThroughStore(match, store, {
    commandId: 'cmd_live_accept', companyId: BUYER, scheduledTick: 2,
    idempotencyKey: 'live:accept', type: 'ACCEPT_SUPPLY_OFFER', contractId: id,
  }, 'live-accept');
  match.advanceTicks(1);
  return id;
}
function ship(match: FactoryMatch, store: MatchStore, id: string, quantity: number): void {
  admitThroughStore(match, store, {
    commandId: 'cmd_live_ship', companyId: SELLER, scheduledTick: match.engine.getCurrentTick() + 1,
    idempotencyKey: 'live:ship', type: 'SCHEDULE_INTERNAL_TRANSPORT', contractId: id, quantityToShip: quantity,
  }, 'live-ship');
  match.advanceTicks(1);
}
test('new durable matches audit real full/partial/zero delivery from inception and resume without duplicate payments', () => {
  for (const delivered of [10, 4, 0]) {
    withMatchStore((store, database) => {
      const match = new FactoryMatch({ store, matchId: MATCH_ID });
      const repo = store.repositories.creditJournal;
      const storedOpening = repo.getOpening(MATCH_ID);
      assert.ok(storedOpening, 'new match commits its opening before the first tick');
      assert.equal(storedOpening.coverage, 'COMPLETE');
      assert.equal(storedOpening.observedAtTick, 0);
      assert.equal(storedOpening.balances.reduce((sum, row) => sum + row.balanceCredits, 0), 40000);
      assert.equal(repo.count(MATCH_ID), 0);
      const id = accept(match, store);
      if (delivered) ship(match, store, id, delivered);
      match.advanceTicks(9 - match.engine.getCurrentTick());
      const journal = match.engine.getCreditLedger();
      assert.equal(journal.opening.matchId, MATCH_ID);
      assert.deepEqual(repo.list(MATCH_ID).map(({ recordedAtUtc: _at, ...movement }) => movement), journal.movements);
      const fee = Math.floor(delivered * 50 * 0.02);
      assert.equal(journal.movements.filter((row) => row.kind === 'FEE_SINK').reduce((sum, row) => sum + row.amountCredits, 0), fee);
      assert.equal(match.engine.getAllCompanies().reduce((sum, company) => sum + company.credits, 0) + fee, 40000);
      const before = snapshotState(database);
      const restarted = new FactoryMatch({ store, matchId: MATCH_ID });
      assert.deepEqual(restarted.engine.getCreditLedger(), journal);
      assert.deepEqual(snapshotState(database), before, 'adoption does not rewrite core rows or journal evidence');
      restarted.advanceTicks(1);
      assert.deepEqual(restarted.engine.getCreditLedger(), journal);
      assert.equal(repo.count(MATCH_ID), journal.movements.length);
    });
  }
});
test('legacy observed cutover preserves core rows and closed contracts without inventing prior fee or back-pay', () => {
  withMatchStore((store, database) => {
    // Build pre-journal persisted state through public engine/repository APIs.
    store.adoptOrCreate({ matchId: MATCH_ID, seed: 42107, tickIntervalMs: 1000 });
    const engine = new SimulatorEngine(42107, MATCH_ID);
    engine.initializeStandardMatch();
    const driver = new ContractDriver(engine);
    driver.createOffer(SELLER, { itemId: 'RAW_ORE', quantity: 10, unitPriceCredits: 50, deadlineTicks: 100 });
    driver.run(1);
    const closed = engine.getAllContracts()[0].contractId;
    driver.acceptOffer(BUYER, closed); driver.run(1);
    driver.ship(SELLER, closed, 10); driver.run(1); // prior fee10 is deliberately unverifiable
    driver.createOffer(SELLER, { itemId: 'RAW_ORE', quantity: 10, unitPriceCredits: 10, deadlineTicks: 100 });
    driver.run(1);
    const active = engine.getAllContracts()[1].contractId;
    driver.acceptOffer(BUYER, active); driver.run(1);
    for (const company of engine.getAllCompanies()) store.repositories.saveCompanyState(company);
    for (const contract of engine.getAllContracts()) store.repositories.contracts.save(contract);
    store.repositories.matches.save(sampleMetadata({ currentTick: 5, sequenceCounter: 5 }));
    const before = snapshotState(database, CORE_STATE_TABLES);
    const match = new FactoryMatch({ store, matchId: MATCH_ID });
    const journal = match.engine.getCreditLedger();
    assert.equal(journal.opening.coverage, 'CUTOVER');
    assert.equal(journal.opening.observedAtTick, 5);
    assert.equal(journal.opening.balances.reduce((sum, row) => sum + row.balanceCredits, 0), 39990);
    assert.deepEqual(journal.movements, []);
    assert.deepEqual(snapshotState(database, CORE_STATE_TABLES), before);
    assert.equal(match.engine.getContract(closed)?.status, 'FULFILLED');
    assert.equal(match.engine.getContract(active)?.status, 'ACTIVE');
    ship(match, store, active, 10);
    const after = match.engine.getCreditLedger();
    assert.ok(after.movements.length > 0);
    assert.ok(after.movements.every((row) => row.contractId === active));
    assert.equal(after.movements.filter((row) => row.kind === 'FEE_SINK').reduce((sum, row) => sum + row.amountCredits, 0), 2);
    assert.equal(match.engine.getAllCompanies().reduce((sum, company) => sum + company.credits, 0) + 2, 39990);
    const restarted = new FactoryMatch({ store, matchId: MATCH_ID });
    assert.deepEqual(restarted.engine.getCreditLedger(), after);
  });
});
