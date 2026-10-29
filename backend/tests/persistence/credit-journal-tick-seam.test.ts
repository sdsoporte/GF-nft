/**
 * T10/S4: combine A's real failed-tick recovery with B's optional journal batch.
 * The test supplies the two acceptance records at the public MatchStore seam;
 * it is not a runtime producer or a claim that T4 settlement is implemented.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FactoryMatch } from '../../src/match.ts';
import type {
  CreditJournalMovementWrite,
  CreditJournalOpeningWrite,
} from '../../src/persistence/repos/index.ts';
import { MATCH_ID, withMatchStore } from './queue-fixtures.ts';
import { admitThroughStore } from './recovery-fixtures.ts';
import { buildRecoveryOracle, canonicalJson } from './recovery-oracle.ts';
import { snapshotState } from './repos-fixtures.ts';

const SELLER = 'comp_metal_01';
const BUYER = 'comp_manuf_01';
const FAULT = 'gf-journal-seam failure after movements';

test('failed acceptance rolls back engine, tick and journal before exactly-once retry', () => {
  withMatchStore((store, database) => {
    const match = new FactoryMatch({ store, matchId: MATCH_ID });
    admitThroughStore(match, store, {
      commandId: 'cmd_journal_offer', companyId: SELLER, scheduledTick: 1,
      idempotencyKey: 'engine:journal-seam:offer', type: 'CREATE_SUPPLY_OFFER',
      targetBuyerId: BUYER, itemId: 'IRON_INGOT', quantity: 10,
      unitPriceCredits: 10, deadlineTicks: 1000,
    }, 'journal-offer');
    match.advanceTicks(1);
    const offer = match.engine.getAllContracts()[0];
    assert.ok(offer);
    assert.equal(offer.status, 'PENDING');

    const opening: CreditJournalOpeningWrite = {
      matchId: MATCH_ID, observedAtTick: 1, coverage: 'CUTOVER',
      balances: match.engine.getAllCompanies().map((company) => ({
        account: { kind: 'AVAILABLE', companyId: company.companyId },
        balanceCredits: company.credits,
      })),
    };
    const persist = store.commitExecutions.bind(store);
    store.commitExecutions = (input) => {
      const active = match.engine.getContract(offer.contractId);
      assert.equal(active?.status, 'ACTIVE');
      assert.ok(active);
      const movements: CreditJournalMovementWrite[] = [
        {
          matchId: MATCH_ID, sequence: 1, eventKey: 'seam:accept:escrow',
          tick: input.metadata.currentTick, contractId: offer.contractId,
          kind: 'BUYER_ESCROW_DEPOSIT', amountCredits: active.totalValueCredits,
          source: { kind: 'AVAILABLE', companyId: BUYER },
          destination: { kind: 'BUYER_ESCROW', companyId: BUYER },
        },
        {
          matchId: MATCH_ID, sequence: 2, eventKey: 'seam:accept:collateral',
          tick: input.metadata.currentTick, contractId: offer.contractId,
          kind: 'SELLER_COLLATERAL_DEPOSIT', amountCredits: active.collateralSellerCredits,
          source: { kind: 'AVAILABLE', companyId: SELLER },
          destination: { kind: 'SELLER_COLLATERAL', companyId: SELLER },
        },
      ];
      // A variable permits the additive input against the old API for RED.
      const batch = { ...input, opening, movements };
      persist(batch);
    };
    const acceptId = admitThroughStore(match, store, {
      commandId: 'cmd_journal_accept', companyId: BUYER, scheduledTick: 2,
      idempotencyKey: 'engine:journal-seam:accept', type: 'ACCEPT_SUPPLY_OFFER',
      contractId: offer.contractId,
    }, 'journal-accept');
    const state = () => canonicalJson({
      simulation: buildRecoveryOracle(match, store, [acceptId]),
      stored: snapshotState(database),
    });
    const before = state();
    database.exec(
      'CREATE TRIGGER gf_fail_after_journal BEFORE INSERT ON match_command_results ' +
      "WHEN NEW.command_id = 'cmd_journal_accept' AND " +
      `(SELECT COUNT(*) FROM credit_ledger_movements WHERE match_id = '${MATCH_ID}') = 2 ` +
      `BEGIN SELECT RAISE(ABORT, '${FAULT}'); END;`,
    );

    assert.throws(() => match.advanceTicks(1), new RegExp(FAULT));
    assert.equal(state(), before, 'failed tick restores all public state and every stored row');
    assert.equal(database.inTransaction, false);
    assert.equal(match.engine.getContract(offer.contractId)?.status, 'PENDING');
    assert.equal(store.repositories.creditJournal.getOpening(MATCH_ID), null);
    assert.deepEqual(store.repositories.creditJournal.list(MATCH_ID), []);

    database.exec('DROP TRIGGER gf_fail_after_journal');
    match.advanceTicks(1);
    assert.equal(match.engine.getCurrentTick(), 2);
    assert.equal(match.engine.getContract(offer.contractId)?.status, 'ACTIVE');
    assert.equal(match.engine.getCompany(BUYER)?.credits, 9900);
    assert.equal(match.engine.getCompany(SELLER)?.credits, 9980);
    assert.equal(store.repositories.matches.load(MATCH_ID)?.currentTick, 2);
    assert.equal(store.repositories.commandResults.count(MATCH_ID), 2);
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 0);
    assert.equal(store.repositories.queue.countProcessed(MATCH_ID), 2);
    const journal = store.repositories.creditJournal;
    assert.equal(journal.getOpening(MATCH_ID)?.coverage, 'CUTOVER');
    assert.deepEqual(journal.list(MATCH_ID).map((movement) => [
      movement.sequence, movement.eventKey, movement.kind, movement.amountCredits,
    ]), [
      [1, 'seam:accept:escrow', 'BUYER_ESCROW_DEPOSIT', 100],
      [2, 'seam:accept:collateral', 'SELLER_COLLATERAL_DEPOSIT', 20],
    ]);
    const committed = snapshotState(database);
    assert.throws(() => journal.append(MATCH_ID, journal.list(MATCH_ID)), {
      code: 'SEQUENCE_OUT_OF_ORDER',
    });
    assert.deepEqual(snapshotState(database), committed, 'replayed event batch cannot double-record');
  });
});
