/**
 * T10/S4: combine A's real failed-tick recovery with B's optional journal batch.
 * Observe real producer input at the public MatchStore seam; a genuine SQL
 * fault after both movements must restore engine, journal, queue and counters.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { FactoryMatch } from '../../src/match.ts';
import type { CreditLedgerMovement } from '../../src/domain/creditLedger.ts';
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

    const openingBefore = store.repositories.creditJournal.getOpening(MATCH_ID);
    const attempts: Array<readonly CreditLedgerMovement[]> = [];
    const persist = store.commitExecutions.bind(store);
    store.commitExecutions = (input) => {
      attempts.push(structuredClone(input.movements ?? []));
      persist(input);
    };
    const acceptId = admitThroughStore(match, store, {
      commandId: 'cmd_journal_accept', companyId: BUYER, scheduledTick: 2,
      idempotencyKey: 'engine:journal-seam:accept', type: 'ACCEPT_SUPPLY_OFFER',
      contractId: offer.contractId,
    }, 'journal-accept');
    const state = () => canonicalJson({
      simulation: buildRecoveryOracle(match, store, [acceptId]),
      journal: match.engine.getCreditLedger(),
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
    assert.deepEqual(store.repositories.creditJournal.getOpening(MATCH_ID), openingBefore);
    assert.deepEqual(store.repositories.creditJournal.list(MATCH_ID), []);

    database.exec('DROP TRIGGER gf_fail_after_journal');
    match.advanceTicks(1);
    assert.equal(match.engine.getCurrentTick(), 2);
    assert.equal(match.engine.getContract(offer.contractId)?.status, 'ACTIVE');
    assert.equal(match.engine.getCompany(BUYER)?.credits, 9900);
    assert.equal(match.engine.getCompany(SELLER)?.credits, 9980);
    assert.equal(store.repositories.matches.load(MATCH_ID)?.currentTick, 2);
    // Issue #55: the same two ticks also execute the NPC policies, which enqueue
    // three opening production targets for comp_metal_02 on tick 1, so both the
    // results and the permanent dedupe rows carry 3 NPC commands next to the two
    // human ones (NPC keys are persisted with the tick that enqueued them). The
    // NPC commands move no credits, so the journal stays at two movements.
    assert.equal(store.repositories.commandResults.count(MATCH_ID), 5);
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 0);
    assert.equal(store.repositories.queue.countProcessed(MATCH_ID), 5);
    const journal = store.repositories.creditJournal;
    assert.equal(journal.getOpening(MATCH_ID)?.coverage, 'COMPLETE');
    assert.deepEqual(attempts[0], attempts[1], 'retry uses identical real event keys, sequence and amounts');
    assert.deepEqual(journal.list(MATCH_ID).map((movement) => [
      movement.sequence, movement.kind, movement.amountCredits,
    ]), [
      [1, 'BUYER_ESCROW_DEPOSIT', 100],
      [2, 'SELLER_COLLATERAL_DEPOSIT', 20],
    ]);
    const committed = snapshotState(database);
    assert.throws(() => journal.append(MATCH_ID, journal.list(MATCH_ID)), {
      code: 'SEQUENCE_OUT_OF_ORDER',
    });
    assert.deepEqual(snapshotState(database), committed, 'replayed event batch cannot double-record');
  });
});
