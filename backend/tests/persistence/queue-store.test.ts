/**
 * Durable command queue, processed idempotency keys, ack ledger and execution
 * history (S3) at the repository/store layer.
 *
 * Each case is a write -> read -> deep-equal round trip, or a direct probe of
 * the constraint that makes the row meaningful (UNIQUE sequence numbers, the
 * pinned ack capacity, rollback of a half-written unit of work). The store
 * tests prove the S8 guarantee that matters for durability: a unit of work
 * either lands completely or leaves every table as it was.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AckLedgerCapacityError,
  CommandNotAccepted,
  createMatchStore,
} from '../../src/persistence/matchStore.ts';
import {
  MATCH_ID,
  FIXED_TIME,
  LATER_TIME,
  sampleAcknowledgement,
  sampleMetadata,
  sampleProcessedKey,
  sampleQueuedCommand,
  withMatchStore,
} from './queue-fixtures.ts';

// --- matches metadata (boot adoption source) ---------------------------------

test('match metadata round-trips every recovery column', () => {
  withMatchStore((store) => {
    const written = sampleMetadata({ currentTick: 7, sequenceCounter: 4, historyCursor: 2 });
    store.repositories.matches.save(written);

    assert.deepEqual(store.repositories.matches.load(MATCH_ID), written);
    assert.deepEqual(store.repositories.matches.load('match_missing'), null);
  });
});

test('match metadata keeps its original created_at_utc when re-saved', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.matches.save(
      sampleMetadata({ updatedAtUtc: LATER_TIME, currentTick: 9, sequenceCounter: 3 }),
    );

    const row = store.repositories.matches.load(MATCH_ID);
    assert.equal(row?.createdAtUtc, FIXED_TIME);
    assert.equal(row?.updatedAtUtc, LATER_TIME);
    assert.equal(row?.currentTick, 9);
    assert.equal(row?.sequenceCounter, 3);
  });
});

test('match metadata rejects negative counters on the write path', () => {
  withMatchStore((store) => {
    for (const field of ['currentTick', 'sequenceCounter', 'historyCursor', 'tickIntervalMs'] as const) {
      assert.throws(
        () => store.repositories.matches.save(sampleMetadata({ [field]: -1 })),
        /must be a non-negative safe integer/,
        `expected ${field} to be rejected`,
      );
    }
    assert.equal(store.repositories.matches.load(MATCH_ID), null);
  });
});

// --- command queue ----------------------------------------------------------

test('a queue row round-trips payload JSON, scheduled tick and sequence number', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    const written = sampleQueuedCommand();
    store.repositories.queue.enqueue(written);

    const pending = store.repositories.queue.listPending(MATCH_ID);
    assert.deepEqual(pending, [written]);
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 1);

    const body = JSON.parse(pending[0].payloadJson);
    assert.equal(body.lineId, 'comp_metal_01_line_1');
    assert.equal(body.recipeId, 'R1');
    assert.equal(body.targetBatches, 1);
  });
});

test('the queue orders pending rows by scheduled tick and then by sequence', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.queue.enqueue(sampleQueuedCommand({ commandId: 'cmd_late', sequenceNumber: 3, scheduledTick: 4, idempotencyKey: 'key-late' }));
    store.repositories.queue.enqueue(sampleQueuedCommand({ commandId: 'cmd_first', sequenceNumber: 2, scheduledTick: 2, idempotencyKey: 'key-first' }));
    store.repositories.queue.enqueue(sampleQueuedCommand({ commandId: 'cmd_second', sequenceNumber: 1, scheduledTick: 2, idempotencyKey: 'key-2' }));

    assert.deepEqual(
      store.repositories.queue.listPending(MATCH_ID).map((row) => row.commandId),
      ['cmd_second', 'cmd_first', 'cmd_late'],
    );
  });
});

test('duplicate idempotency keys are rejected by the queue', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.queue.enqueue(sampleQueuedCommand());

    assert.throws(() =>
      store.repositories.queue.enqueue(
        sampleQueuedCommand({ commandId: 'cmd_queue_2', sequenceNumber: 2 }),
      ),
    );
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 1);
  });
});

test('duplicate sequence numbers are rejected by the queue', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.queue.enqueue(sampleQueuedCommand());

    assert.throws(() =>
      store.repositories.queue.enqueue(
        sampleQueuedCommand({ commandId: 'cmd_queue_2', idempotencyKey: 'key-2' }),
      ),
    );
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 1);
  });
});

test('processed idempotency keys outlive the queue row they deduplicated', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.queue.enqueue(sampleQueuedCommand());
    store.repositories.queue.markProcessed(sampleProcessedKey());

    assert.equal(store.repositories.queue.isProcessed(MATCH_ID, `http:${MATCH_ID}:request-1`), true);
    assert.equal(store.repositories.queue.isProcessed(MATCH_ID, 'http:unknown'), false);

    assert.equal(store.repositories.queue.remove(MATCH_ID, ['cmd_queue_1']), 1);
    assert.equal(store.repositories.queue.countPending(MATCH_ID), 0);
    assert.equal(store.repositories.queue.isProcessed(MATCH_ID, `http:${MATCH_ID}:request-1`), true);
    assert.deepEqual(
      store.repositories.queue.listProcessed(MATCH_ID),
      [sampleProcessedKey()],
    );
  });
});

test('remove() clears exactly the executed command ids', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.queue.enqueue(sampleQueuedCommand({ commandId: 'cmd_a', sequenceNumber: 1, idempotencyKey: 'key-a' }));
    store.repositories.queue.enqueue(sampleQueuedCommand({ commandId: 'cmd_b', sequenceNumber: 2, idempotencyKey: 'key-b' }));
    store.repositories.queue.enqueue(sampleQueuedCommand({ commandId: 'cmd_c', sequenceNumber: 3, idempotencyKey: 'key-c' }));

    assert.equal(store.repositories.queue.remove(MATCH_ID, ['cmd_a', 'cmd_c']), 2);
    assert.deepEqual(
      store.repositories.queue.listPending(MATCH_ID).map((row) => row.commandId),
      ['cmd_b'],
    );
    assert.equal(store.repositories.queue.remove(MATCH_ID, ['cmd_a']), 0);
  });
});

// --- ack ledger -------------------------------------------------------------

test('the ack ledger round-trips request ids in acknowledgement order', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    const first = sampleAcknowledgement();
    const second = sampleAcknowledgement({
      requestId: 'request-2',
      commandId: 'cmd_queue_2',
      acknowledgedAtUtc: LATER_TIME,
    });
    store.repositories.ackLedger.record({ ...first, capacity: 1024 });
    store.repositories.ackLedger.record({ ...second, capacity: 1024 });

    assert.deepEqual(store.repositories.ackLedger.get(MATCH_ID, 'request-1'), first);
    assert.deepEqual(store.repositories.ackLedger.list(MATCH_ID), [first, second]);
    assert.equal(store.repositories.ackLedger.count(MATCH_ID), 2);
    assert.equal(store.repositories.ackLedger.get(MATCH_ID, 'request-missing'), null);
  });
});

test('the ack ledger refuses new rows at capacity instead of evicting an acknowledgement', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.ackLedger.record({ ...sampleAcknowledgement(), capacity: 2 });
    store.repositories.ackLedger.record({
      ...sampleAcknowledgement({ requestId: 'request-2', commandId: 'cmd_queue_2' }),
      capacity: 2,
    });

    assert.throws(
      () =>
        store.repositories.ackLedger.record({
          ...sampleAcknowledgement({ requestId: 'request-3', commandId: 'cmd_queue_3' }),
          capacity: 2,
        }),
      AckLedgerCapacityError,
    );
    assert.equal(store.repositories.ackLedger.count(MATCH_ID), 2);
    assert.deepEqual(
      store.repositories.ackLedger.list(MATCH_ID).map((row) => row.requestId),
      ['request-1', 'request-2'],
    );
  });
});

// --- execution history ------------------------------------------------------

test('command results append in history order and keep the failure detail', () => {
  withMatchStore((store) => {
    store.repositories.matches.save(sampleMetadata());
    store.repositories.commandResults.appendMany([
      {
        matchId: MATCH_ID,
        historyIndex: 0,
        commandId: 'cmd_queue_1',
        idempotencyKey: `http:${MATCH_ID}:request-1`,
        executedAtTick: 1,
        success: true,
      },
      {
        matchId: MATCH_ID,
        historyIndex: 1,
        commandId: 'cmd_queue_2',
        idempotencyKey: `http:${MATCH_ID}:request-2`,
        executedAtTick: 1,
        success: false,
        errorCode: 'ERR_INSUFFICIENT_INVENTORY',
        errorMessage: 'Insufficient materials to start recipe R1',
      },
    ]);

    const rows = store.repositories.commandResults.list(MATCH_ID);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      matchId: MATCH_ID,
      historyIndex: 0,
      commandId: 'cmd_queue_1',
      idempotencyKey: `http:${MATCH_ID}:request-1`,
      executedAtTick: 1,
      success: true,
    });
    assert.equal(rows[1].success, false);
    assert.equal(rows[1].errorCode, 'ERR_INSUFFICIENT_INVENTORY');
    assert.equal(store.repositories.commandResults.count(MATCH_ID), 2);
  });
});

// --- atomic units of work (risk item 4) -------------------------------------

test('a refused engine admission leaves no queue, ack or metadata rows behind', () => {
  withMatchStore((store) => {
    const boot = store.adoptOrCreate({ seed: 42107, tickIntervalMs: 1000, matchId: MATCH_ID });
    assert.equal(boot.metadata.sequenceCounter, 0);

    assert.throws(
      () =>
        store.commitCommand({
          metadata: sampleMetadata({ sequenceCounter: 1, updatedAtUtc: LATER_TIME }),
          command: sampleQueuedCommand(),
          processed: sampleProcessedKey(),
          acknowledgement: { ...sampleAcknowledgement(), capacity: 1024 },
          apply: () => false,
        }),
      CommandNotAccepted,
    );

    assert.equal(store.repositories.queue.countPending(MATCH_ID), 0);
    assert.equal(store.repositories.queue.isProcessed(MATCH_ID, `http:${MATCH_ID}:request-1`), false);
    assert.equal(store.repositories.ackLedger.count(MATCH_ID), 0);
    assert.deepEqual(store.repositories.matches.load(MATCH_ID), boot.metadata);
  });
});

test('a failing queue insert rolls back the metadata and ack rows of the same unit', () => {
  withMatchStore((store) => {
    const boot = store.adoptOrCreate({ seed: 42107, tickIntervalMs: 1000, matchId: MATCH_ID });
    store.commitCommand({
      metadata: sampleMetadata({ sequenceCounter: 1 }),
      command: sampleQueuedCommand(),
      processed: sampleProcessedKey(),
      acknowledgement: { ...sampleAcknowledgement(), capacity: 1024 },
      apply: () => true,
    });

    // Same sequence number as the committed row: the queue UNIQUE guard fires
    // after the metadata and ack writes of this unit, so both must roll back.
    assert.throws(() =>
      store.commitCommand({
        metadata: sampleMetadata({ sequenceCounter: 2, updatedAtUtc: LATER_TIME }),
        command: sampleQueuedCommand({ commandId: 'cmd_queue_2' }),
        processed: sampleProcessedKey({ idempotencyKey: 'http:other', commandId: 'cmd_queue_2' }),
        acknowledgement: { ...sampleAcknowledgement({ requestId: 'request-2', commandId: 'cmd_queue_2' }), capacity: 1024 },
        apply: () => true,
      }),
    );

    assert.equal(store.repositories.ackLedger.count(MATCH_ID), 1);
    assert.equal(store.repositories.queue.isProcessed(MATCH_ID, 'http:other'), false);
    assert.equal(store.repositories.matches.load(MATCH_ID)?.sequenceCounter, 1);
    assert.notEqual(store.repositories.matches.load(MATCH_ID)?.updatedAtUtc, LATER_TIME);
    assert.equal(boot.metadata.sequenceCounter, 0);
  });
});

test('creating a store twice on the same database adopts the existing rows', () => {
  withMatchStore((store, database) => {
    store.adoptOrCreate({ seed: 42107, tickIntervalMs: 1000, matchId: MATCH_ID });
    const second = createMatchStore(database);
    const boot = second.adoptOrCreate({ seed: 999, tickIntervalMs: 250, matchId: MATCH_ID });

    assert.equal(boot.adopted, true);
    assert.equal(boot.metadata.seed, 42107);
    assert.equal(boot.metadata.tickIntervalMs, 1000);
  });
});
