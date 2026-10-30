/**
 * Match-level durability (S3/S6/S8) for the command queue, processed
 * idempotency keys and the ack ledger.
 *
 * The tests drive `FactoryMatch` directly — no HTTP listener, no port, no
 * clock thread — and reopen the same database file to prove what survives a
 * process restart. Scope boundary (A6/L8): T3 restores the MATCH-side ledger,
 * command records and history cursor; hydrating the engine's internal queue is
 * T4, so these tests never assert that a pending engine command resumes.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';

import { FactoryMatch, MAX_ACKNOWLEDGED_REQUESTS } from '../../src/match.ts';
import { closeDatabase } from '../../src/persistence/database.ts';
import type { MatchStore } from '../../src/persistence/matchStore.ts';
import {
  MATCH_ID,
  SERVER_LINE,
  openPersistedStore,
  productionPayload,
  withMatchStore,
  withTempDirectory,
} from './queue-fixtures.ts';

function request(match: FactoryMatch, requestId: string, lineId: string = SERVER_LINE) {
  return match.requestProduction(productionPayload({ requestId, lineId }));
}

test('an accepted request persists its queue row, idempotency key and acknowledgement', () => {
  withMatchStore((store) => {
    const match = new FactoryMatch({ store, matchId: MATCH_ID });
    const decision = match.requestProduction(productionPayload());

    assert.equal(decision.kind, 'queued');
    if (decision.kind !== 'queued') return;

    const pending = store.repositories.queue.listPending(MATCH_ID);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].commandId, decision.commandId);
    assert.equal(pending[0].companyId, 'comp_metal_01');
    assert.equal(pending[0].sequenceNumber, 1);
    assert.equal(pending[0].scheduledTick, 1);
    assert.equal(pending[0].idempotencyKey, `http:${MATCH_ID}:request-1`);
    assert.equal(pending[0].commandType, 'SET_PRODUCTION_TARGET');
    assert.equal(store.repositories.queue.isProcessed(MATCH_ID, pending[0].idempotencyKey), true);

    const acknowledgement = store.repositories.ackLedger.get(MATCH_ID, 'request-1');
    assert.equal(acknowledgement?.commandId, decision.commandId);
    assert.equal(acknowledgement?.fingerprint, `${SERVER_LINE}\nR1`);

    const metadata = store.repositories.matches.load(MATCH_ID);
    assert.equal(metadata?.sequenceCounter, 1);
    assert.equal(metadata?.currentTick, 0);
    assert.equal(metadata?.historyCursor, 0);
    assert.equal(metadata?.tickIntervalMs, 1000);
  });
});

test('a rejected request writes nothing at all', () => {
  withMatchStore((store) => {
    const match = new FactoryMatch({ store, matchId: MATCH_ID });

    assert.equal(match.requestProduction(productionPayload({ recipeId: 'R2' })).kind, 'unsupported_recipe');
    assert.equal(match.requestProduction(productionPayload({ lineId: 'line_not_owned' })).kind, 'line_not_owned');

    assert.equal(match.requestProduction(productionPayload()).kind, 'queued');
    const reused = match.requestProduction(productionPayload({ lineId: 'comp_metal_01_line_2' }));
    assert.equal(reused.kind, 'request_id_reused');

    assert.equal(match.engine.getCommandQueue().getPendingCount(), 1);
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 1);
    assert.equal(store.repositories.ackLedger.count(MATCH_ID), 1);
    assert.equal(store.repositories.matches.load(MATCH_ID)?.sequenceCounter, 1);
  });
});

test('an exact retry reuses the acknowledgement and writes no second movement', () => {
  withMatchStore((store) => {
    const match = new FactoryMatch({ store, matchId: MATCH_ID });
    const first = match.requestProduction(productionPayload());
    const retry = match.requestProduction(productionPayload());

    assert.deepEqual(retry, first);
    assert.equal(match.engine.getCommandQueue().getPendingCount(), 1);
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 1);
    assert.equal(store.repositories.ackLedger.count(MATCH_ID), 1);
    assert.equal(store.repositories.matches.load(MATCH_ID)?.sequenceCounter, 1);
  });
});

test('executing a command moves it from the queue row to the results and advances the cursor', () => {
  withMatchStore((store) => {
    const match = new FactoryMatch({ store, matchId: MATCH_ID });
    const decision = match.requestProduction(productionPayload());
    assert.equal(decision.kind, 'queued');
    if (decision.kind !== 'queued') return;

    match.advanceTicks(1);

    assert.equal(store.repositories.queue.countPending(MATCH_ID), 0);
    const results = store.repositories.commandResults.list(MATCH_ID);
    // Issue #55: the tick also drives the NPC policies, which enqueue three
    // opening production targets for comp_metal_02 that execute before the
    // human command (they are scheduled on tick 0, the human one on tick 1).
    assert.equal(results.length, 4);
    const human = results.filter((result) => result.commandId === decision.commandId);
    assert.equal(human.length, 1);
    assert.equal(human[0].historyIndex, 3);
    assert.equal(human[0].executedAtTick, 1);
    assert.equal(human[0].success, true);

    const metadata = store.repositories.matches.load(MATCH_ID);
    assert.equal(metadata?.historyCursor, 4);
    assert.equal(metadata?.currentTick, 1);
    assert.deepEqual(match.getCommandStatus(decision.commandId), {
      commandId: decision.commandId,
      status: 'executed',
      executedAtTick: 1,
    });
  });
});

test('a tick without commands still persists the current tick and the cursor', () => {
  withMatchStore((store) => {
    const match = new FactoryMatch({ store, matchId: MATCH_ID });
    match.advanceTicks(3);

    const metadata = store.repositories.matches.load(MATCH_ID);
    assert.equal(metadata?.currentTick, 3);
    // Issue #55: NPC policies execute their three opening production targets on
    // tick 1. Ticks 2 and 3 have no command at all, and the cursor still tracks
    // the every-tick persistence instead of moving only when work happens.
    assert.equal(metadata?.historyCursor, 3);
    const results = store.repositories.commandResults.list(MATCH_ID);
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((result) => result.executedAtTick), [1, 1, 1]);
  });
});

test('reopening the database restores the ack ledger, command statuses and the cursor', () => {
  withTempDirectory((directory) => {
    const path = `${directory}/factory.db`;
    const first = openPersistedStore(path);
    const match = new FactoryMatch({ store: first.store, matchId: MATCH_ID });
    const decision = match.requestProduction(productionPayload());
    assert.equal(decision.kind, 'queued');
    if (decision.kind !== 'queued') return;
    match.advanceTicks(1);
    const beforeClose = match.getCommandStatus(decision.commandId);
    closeDatabase(first.database);

    const second = openPersistedStore(path);
    try {
      const reopened = new FactoryMatch({ store: second.store });
      assert.equal(reopened.matchId, MATCH_ID, 'the match identity must be adopted, not regenerated');
      assert.equal(reopened.getAcknowledgedRequestCount(), 1);
      assert.deepEqual(reopened.getCommandStatus(decision.commandId), beforeClose);

      const replay = reopened.requestProduction(productionPayload());
      assert.deepEqual(replay, { kind: 'queued', commandId: decision.commandId });
      assert.deepEqual(reopened.getCommandStatus(decision.commandId), beforeClose);

      assert.equal(reopened.engine.getCommandQueue().getPendingCount(), 0, 'a replay must not enqueue a second command');
      assert.equal(second.store.repositories.queue.countPending(MATCH_ID), 0);
      // Issue #55: three NPC production targets plus the human command ran on
      // tick 1, so the results and the cursor carry 4. NPC commands skip the
      // store-admission path, so their dedupe keys are persisted with the tick
      // that enqueued them: the durable table holds all 4, which is what lets the
      // reopened engine re-arm its dedupe guard for NPC commands too.
      assert.equal(second.store.repositories.queue.countProcessed(MATCH_ID), 4);
      assert.equal(
        second.store.repositories.queue.listProcessed(MATCH_ID)
          .filter((record) => record.idempotencyKey.startsWith('npc_prod_')).length,
        3,
        'the three NPC production keys are durable, not only in memory',
      );
      assert.equal(second.store.repositories.ackLedger.count(MATCH_ID), 1);
      assert.equal(second.store.repositories.commandResults.count(MATCH_ID), 4);
      assert.equal(second.store.repositories.matches.load(MATCH_ID)?.historyCursor, 4);

      // The adopted cursor never regresses, even though the rebuilt engine has
      // no execution history yet: nothing had executed before the first close
      reopened.advanceTicks(1);
      assert.equal(second.store.repositories.matches.load(MATCH_ID)?.historyCursor, 4);
      assert.equal(second.store.repositories.commandResults.count(MATCH_ID), 4);
    } finally {
      closeDatabase(second.database);
    }
  });
});

test('reopening keeps a still-pending command visible as queued', () => {
  withTempDirectory((directory) => {
    const path = `${directory}/factory.db`;
    const first = openPersistedStore(path);
    const match = new FactoryMatch({ store: first.store, matchId: MATCH_ID });
    const decision = match.requestProduction(productionPayload());
    assert.equal(decision.kind, 'queued');
    if (decision.kind !== 'queued') return;
    closeDatabase(first.database);

    const second = openPersistedStore(path);
    try {
      const reopened = new FactoryMatch({ store: second.store });
      assert.deepEqual(reopened.getCommandStatus(decision.commandId), {
        commandId: decision.commandId,
        status: 'queued',
      });
      // A fresh requestId keeps the persisted sequence counter monotonic.
      const next = reopened.requestProduction(productionPayload({ requestId: 'request-2' }));
      assert.equal(next.kind, 'queued');
      assert.deepEqual(
        second.store.repositories.queue.listPending(MATCH_ID).map((row) => row.sequenceNumber),
        [1, 2],
      );
    } finally {
      closeDatabase(second.database);
    }
  });
});

test('boot adoption takes the match identity from the persisted row, not the options', () => {
  withTempDirectory((directory) => {
    const path = `${directory}/factory.db`;
    const first = openPersistedStore(path);
    const match = new FactoryMatch({ store: first.store, matchId: MATCH_ID, seed: 999, tickIntervalMs: 250 });
    assert.equal(match.matchId, MATCH_ID);
    assert.equal(match.tickIntervalMs, 250);
    closeDatabase(first.database);

    const second = openPersistedStore(path);
    try {
      const adopted = new FactoryMatch({ store: second.store, seed: 42107, tickIntervalMs: 1000 });
      assert.equal(adopted.matchId, MATCH_ID);
      assert.equal(adopted.tickIntervalMs, 250);
      assert.equal(adopted.getStatePayload().tickIntervalMs, 250);

      const metadata = second.store.repositories.matches.load(MATCH_ID);
      assert.equal(metadata?.seed, 999);
      assert.equal(metadata?.tickIntervalMs, 250);
    } finally {
      closeDatabase(second.database);
    }
  });
});

test('an explicit matchId against a different persisted match starts its own row', () => {
  withMatchStore((store) => {
    new FactoryMatch({ store, matchId: 'match_original' });
    const other = new FactoryMatch({ store, matchId: 'match_other' });

    assert.equal(other.matchId, 'match_other');
    assert.equal(store.repositories.matches.load('match_original')?.matchId, 'match_original');
    assert.equal(store.repositories.matches.load('match_other')?.matchId, 'match_other');
    assert.equal(other.getAcknowledgedRequestCount(), 0);
  });
});

test('without a store the match behaves exactly as before and touches no database', () => {
  withTempDirectory((directory) => {
    const match = new FactoryMatch({ matchId: MATCH_ID });
    const decision = match.requestProduction(productionPayload());
    assert.equal(decision.kind, 'queued');
    if (decision.kind !== 'queued') return;

    match.advanceTicks(1);
    assert.deepEqual(match.getCommandStatus(decision.commandId), {
      commandId: decision.commandId,
      status: 'executed',
      executedAtTick: 1,
    });
    assert.equal(match.getAcknowledgedRequestCount(), 1);
    assert.deepEqual(readdirSync(directory), [], 'a store-free match must not write any file');
  });
});

test('the 1024-acknowledgement boundary behaves identically with persistence on and across a reopen', () => {
  withTempDirectory((directory) => {
    const path = `${directory}/factory.db`;
    const first = openPersistedStore(path);
    let firstAck: unknown = null;
    try {
      const match = new FactoryMatch({ store: first.store, matchId: MATCH_ID });
      for (let index = 0; index < MAX_ACKNOWLEDGED_REQUESTS; index += 1) {
        const decision = match.requestProduction(productionPayload({ requestId: `limit-${index}` }));
        assert.equal(decision.kind, 'queued', `request limit-${index} was not accepted`);
        if (index === 0) firstAck = decision;
      }
      assert.equal(match.engine.getCommandQueue().getPendingCount(), MAX_ACKNOWLEDGED_REQUESTS);
      assert.equal(first.store.repositories.ackLedger.count(MATCH_ID), MAX_ACKNOWLEDGED_REQUESTS);

      assert.deepEqual(match.requestProduction(productionPayload({ requestId: 'limit-0' })), firstAck);
      assert.equal(match.requestProduction(productionPayload({ requestId: 'limit-overflow' })).kind, 'command_limit');
      assert.equal(match.engine.getCommandQueue().getPendingCount(), MAX_ACKNOWLEDGED_REQUESTS);
      assert.equal(first.store.repositories.ackLedger.count(MATCH_ID), MAX_ACKNOWLEDGED_REQUESTS);
    } finally {
      closeDatabase(first.database);
    }

    const second = openPersistedStore(path);
    try {
      const reopened = new FactoryMatch({ store: second.store });
      assert.equal(reopened.getAcknowledgedRequestCount(), MAX_ACKNOWLEDGED_REQUESTS);
      assert.deepEqual(reopened.requestProduction(productionPayload({ requestId: 'limit-0' })), firstAck);
      assert.equal(reopened.requestProduction(productionPayload({ requestId: 'limit-overflow' })).kind, 'command_limit');
      assert.equal(reopened.engine.getCommandQueue().getPendingCount(), MAX_ACKNOWLEDGED_REQUESTS);
      assert.equal(second.store.repositories.ackLedger.count(MATCH_ID), MAX_ACKNOWLEDGED_REQUESTS);
    } finally {
      closeDatabase(second.database);
    }
  });
});

test('a store shared by two matches keeps their ledgers separate', () => {
  withMatchStore((store) => {
    const stored: MatchStore = store;
    const alpha = new FactoryMatch({ store: stored, matchId: 'match_alpha' });
    const beta = new FactoryMatch({ store: stored, matchId: 'match_beta' });
    alpha.requestProduction(productionPayload({ requestId: 'request-1' }));

    assert.equal(stored.repositories.ackLedger.count('match_alpha'), 1);
    assert.equal(stored.repositories.ackLedger.count('match_beta'), 0);
    assert.equal(beta.getAcknowledgedRequestCount(), 0);
  });
});

