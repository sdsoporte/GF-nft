/**
 * S4/S14 — durable append-only credit journal (storage and audit foundation).
 *
 * What these tests pin, and what they deliberately do not:
 *
 * - the journal is a new schema version with an immutable per-match opening
 *   (observed tick, COMPLETE for a new match / CUTOVER for legacy state and
 *   typed observed balances) and append-only positive movements with a
 *   contiguous per-match sequence and a stable unique event key;
 * - an upgrade adds the tables and changes no legacy row, and backfills no
 *   history: the journal starts empty even when contracts and credits exist;
 * - movement kinds separate buyer escrow, seller collateral, delivery payment,
 *   the market-fee sink, indemnity transfers, refunds and the contract-less
 *   maintenance sink. The nullable contract column is never a uniqueness key,
 *   and a penalty is a transfer between accounts, never a burned movement;
 * - every rejected input has an exact code and leaves the stored rows (and the
 *   surrounding snapshot) untouched;
 * - `MatchStore.commitExecutions` can create the opening and append movements
 *   inside its existing tick transaction, and a rejection rolls back the tick
 *   metadata, the journal rows, the execution history and any queued removal.
 *
 * Math of a settlement (2% fee, partial delivery, default compensation) is a
 * later integration unit; here a movement is only stored and read back.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CreditLedgerValidationError,
  validateCreditMovement,
  type CreditAccountRef,
  type CreditCompanyAccountRef,
  type CreditLedgerMovement,
  type CreditLedgerOpening,
} from '../../src/domain/creditLedger.ts';
import { createMatchStore } from '../../src/persistence/matchStore.ts';
import {
  MIGRATIONS,
  getAppliedMigrations,
  getCurrentVersion,
  migrate,
} from '../../src/persistence/migrations.ts';
import {
  CreditJournalError,
  createRepositories,
  type CreditJournalMovementWrite,
  type CreditJournalOpeningWrite,
} from '../../src/persistence/repos/index.ts';
import { runAtomic } from '../../src/persistence/transaction.ts';
import {
  COMPANY_FACTORY,
  COMPANY_METAL,
  CORE_STATE_TABLES,
  JOURNAL_STATE_TABLES,
  JOURNAL_MATCH_ID,
  countRows,
  sampleCompanyState,
  sampleContract,
  sampleCreditMovement,
  sampleCreditOpening,
  seedCompanies,
  seedJournalMatch,
  snapshotState,
  withDatabase,
  withRepositories,
} from './repos-fixtures.ts';

/** Versions 1-6: a database written before the credit journal existed. */
const LEGACY_MIGRATIONS = MIGRATIONS.filter((migration) => migration.version <= 6);

function journalMigration() {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 7);
  assert.ok(migration, 'the credit-journal storage migration must be registered as version 7');
  return migration;
}

const AT_UTC = '2026-01-01T00:10:00.000Z';

/** One escrow deposit from the sample buyer, with an optional override. */
function deposit(overrides: Partial<CreditLedgerMovement> = {}): CreditLedgerMovement {
  return sampleCreditMovement(overrides);
}

/** Assert a domain rejection: exact code plus the `CODE: detail` message shape. */
function rejectsValidation(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.equal(
      error instanceof CreditLedgerValidationError,
      true,
      `expected a CreditLedgerValidationError for ${code}, received ${String(error)}`,
    );
    const rejection = error as CreditLedgerValidationError;
    assert.equal(rejection.code, code);
    assert.match(rejection.message, new RegExp(`^${code}: `));
    return true;
  };
}

/** Assert a persistence rejection: exact code plus the `CODE: detail` message shape. */
function rejectsJournal(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.equal(
      error instanceof CreditJournalError,
      true,
      `expected a CreditJournalError for ${code}, received ${String(error)}`,
    );
    const rejection = error as CreditJournalError;
    assert.equal(rejection.code, code);
    assert.match(rejection.message, new RegExp(`^${code}: `));
    return true;
  };
}

test('fresh version-7 storage round-trips an immutable opening and ordered movements', () => {
  withRepositories((repos, database) => {
    assert.equal(getCurrentVersion(database), 7);
    seedJournalMatch(repos, 10);

    const openingRequest: CreditJournalOpeningWrite = { ...sampleCreditOpening(), openedAtUtc: AT_UTC };
    const opening = repos.creditJournal.createOpening(openingRequest);
    assert.deepEqual(opening, { ...sampleCreditOpening(), openedAtUtc: AT_UTC });
    assert.deepEqual(repos.creditJournal.getOpening(JOURNAL_MATCH_ID), opening);

    const movements: CreditJournalMovementWrite[] = [
      deposit({ sequence: 1, eventKey: 'evt_deposit', tick: 5 }),
      deposit({
        sequence: 2,
        eventKey: 'evt_collateral',
        tick: 6,
        kind: 'SELLER_COLLATERAL_DEPOSIT',
        amountCredits: 240,
        source: { kind: 'AVAILABLE', companyId: COMPANY_METAL },
        destination: { kind: 'SELLER_COLLATERAL', companyId: COMPANY_METAL },
      }),
      // S10 shape: 200 delivered, 196 to the seller and 4 to the fee sink.
      deposit({
        sequence: 3,
        eventKey: 'evt_delivery',
        tick: 7,
        kind: 'DELIVERY_PAYMENT',
        amountCredits: 196,
        source: { kind: 'BUYER_ESCROW', companyId: COMPANY_FACTORY },
        destination: { kind: 'AVAILABLE', companyId: COMPANY_METAL },
      }),
      deposit({
        sequence: 4,
        eventKey: 'evt_fee',
        tick: 7,
        kind: 'FEE_SINK',
        amountCredits: 4,
        source: { kind: 'BUYER_ESCROW', companyId: COMPANY_FACTORY },
        destination: { kind: 'MARKET_FEE_SINK' },
      }),
    ];
    const stored = repos.creditJournal.append(
      JOURNAL_MATCH_ID,
      movements.map((movement) => ({ ...movement, recordedAtUtc: AT_UTC })),
    );
    assert.deepEqual(
      stored,
      movements.map((movement) => ({ ...movement, recordedAtUtc: AT_UTC })),
    );
    assert.deepEqual(repos.creditJournal.list(JOURNAL_MATCH_ID), stored);
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 4);
  });
});

test('an existing opening is immutable: it cannot be replaced or rewritten', () => {
  withRepositories((repos, database) => {
    seedJournalMatch(repos, 10);
    const opening = repos.creditJournal.createOpening(sampleCreditOpening());
    const before = snapshotState(database);

    assert.throws(
      () =>
        repos.creditJournal.createOpening(
          sampleCreditOpening({ coverage: 'CUTOVER', observedAtTick: 5 }),
        ),
      rejectsJournal('OPENING_EXISTS'),
    );

    assert.deepEqual(snapshotState(database), before);
    assert.deepEqual(repos.creditJournal.getOpening(JOURNAL_MATCH_ID), opening);
  });
});

test('an opening cannot be dated in the future of its match', () => {
  withRepositories((repos, database) => {
    seedJournalMatch(repos, 4);
    assert.throws(
      () => repos.creditJournal.createOpening(sampleCreditOpening({ observedAtTick: 5 })),
      rejectsJournal('FUTURE_TICK'),
    );
    assert.equal(countRows(database, 'credit_ledger_openings'), 0);
  });
});



test('unsafe movements are rejected with exact codes and write no row', () => {
  withRepositories((repos) => {
    seedJournalMatch(repos, 10);
    repos.creditJournal.createOpening(sampleCreditOpening());
    const base = deposit({ sequence: 1, eventKey: 'evt_valid', tick: 5 });

    const cases: readonly (readonly [string, unknown, string])[] = [
      ['match id blank', { matchId: '' }, 'INVALID_MATCH_ID'],
      ['event key blank', { eventKey: '' }, 'INVALID_EVENT_KEY'],
      ['sequence zero', { sequence: 0 }, 'INVALID_SEQUENCE'],
      ['sequence negative', { sequence: -1 }, 'INVALID_SEQUENCE'],
      ['sequence fractional', { sequence: 1.5 }, 'INVALID_SEQUENCE'],
      ['tick negative', { tick: -1 }, 'INVALID_TICK'],
      ['tick fractional', { tick: 5.5 }, 'INVALID_TICK'],
      ['amount zero', { amountCredits: 0 }, 'INVALID_AMOUNT'],
      ['amount negative', { amountCredits: -5 }, 'INVALID_AMOUNT'],
      ['amount fractional', { amountCredits: 1.5 }, 'INVALID_AMOUNT'],
      ['amount beyond safe integer', { amountCredits: Number.MAX_SAFE_INTEGER + 1 }, 'INVALID_AMOUNT'],
      ['unknown movement kind', { kind: 'PENALTY_BURN' }, 'UNKNOWN_MOVEMENT_KIND'],
      ['deposit without a contract', { contractId: undefined }, 'MISSING_CONTRACT_ID'],
      ['deposit with a blank contract', { contractId: '  ' }, 'INVALID_CONTRACT_ID'],
      ['source account missing', { source: undefined }, 'INVALID_ACCOUNT'],
      ['source account kind unknown', { source: { kind: 'PENALTY_BURN' } }, 'INVALID_ACCOUNT_KIND'],
      ['source company missing', { source: { kind: 'AVAILABLE' } }, 'INVALID_ACCOUNT_COMPANY'],
      ['sink carrying a company', { destination: { kind: 'MARKET_FEE_SINK', companyId: COMPANY_METAL } },
        'SINK_ACCOUNT_HAS_COMPANY'],
      ['deposit routed out of escrow', { source: { kind: 'BUYER_ESCROW', companyId: COMPANY_FACTORY } },
        'INVALID_MOVEMENT_ROUTE'],
      ['deposit into another company escrow', { destination: { kind: 'BUYER_ESCROW', companyId: COMPANY_METAL } },
        'MOVEMENT_COMPANY_MISMATCH'],
    ];

    for (const [label, patch, code] of cases) {
      const invalid = { ...base, ...(patch as Record<string, unknown>) } as unknown as CreditLedgerMovement;
      assert.throws(
        () => repos.creditJournal.append(JOURNAL_MATCH_ID, [invalid]),
        rejectsValidation(code),
        label,
      );
      assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 0, label);
    }
  });
});

test('maintenance movements carry no contract id and stay distinct by event key', () => {
  withRepositories((repos) => {
    seedJournalMatch(repos, 10);
    repos.creditJournal.createOpening(sampleCreditOpening());

    const maintenance = (sequence: number, eventKey: string): CreditLedgerMovement => ({
      matchId: JOURNAL_MATCH_ID,
      sequence,
      eventKey,
      tick: 6,
      kind: 'MAINTENANCE_SINK',
      amountCredits: 10,
      source: { kind: 'AVAILABLE', companyId: COMPANY_METAL },
      destination: { kind: 'MAINTENANCE_SINK' },
    });
    const stored = repos.creditJournal.append(JOURNAL_MATCH_ID, [
      maintenance(1, 'evt_maintenance_1'),
      maintenance(2, 'evt_maintenance_2'),
    ]);
    assert.equal(stored.length, 2);
    assert.equal('contractId' in stored[0], false);
    assert.equal('contractId' in stored[1], false);

    assert.throws(
      () =>
        repos.creditJournal.append(JOURNAL_MATCH_ID, [
          { ...maintenance(3, 'evt_maintenance_3'), contractId: 'contract_1' },
        ]),
      rejectsValidation('UNEXPECTED_CONTRACT_ID'),
    );
  });
});

test('a penalty is a transfer from seller collateral to the buyer, never a burn', () => {
  withRepositories((repos) => {
    seedJournalMatch(repos, 10);
    repos.creditJournal.createOpening(sampleCreditOpening());

    const indemnity: CreditJournalMovementWrite = {
      matchId: JOURNAL_MATCH_ID,
      sequence: 1,
      eventKey: 'evt_indemnity',
      tick: 8,
      contractId: 'contract_1',
      kind: 'INDEMNITY_TRANSFER',
      amountCredits: 60,
      source: { kind: 'SELLER_COLLATERAL', companyId: COMPANY_METAL },
      destination: { kind: 'AVAILABLE', companyId: COMPANY_FACTORY },
      recordedAtUtc: AT_UTC,
    };
    assert.deepEqual(repos.creditJournal.append(JOURNAL_MATCH_ID, [indemnity]), [indemnity]);
    assert.deepEqual(repos.creditJournal.list(JOURNAL_MATCH_ID), [indemnity]);

    for (const kind of ['PENALTY_BURN', 'FEE_BURN']) {
      assert.throws(
        () => validateCreditMovement({ ...indemnity, kind } as CreditLedgerMovement),
        rejectsValidation('UNKNOWN_MOVEMENT_KIND'),
        kind,
      );
    }
  });
});

test('duplicate event keys and reordered sequences roll back without keeping partial rows', () => {
  withRepositories((repos) => {
    seedJournalMatch(repos, 10);
    repos.creditJournal.createOpening(sampleCreditOpening());

    repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 1, eventKey: 'evt_1', tick: 5 })]);

    // Reordered: the store expects sequence 2 before anything else.
    assert.throws(
      () => repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 3, eventKey: 'evt_3', tick: 6 })]),
      rejectsJournal('SEQUENCE_OUT_OF_ORDER'),
    );
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 1);

    // A duplicate sequence inside one batch is rejected before the second insert.
    assert.throws(
      () =>
        repos.creditJournal.append(JOURNAL_MATCH_ID, [
          deposit({ sequence: 2, eventKey: 'evt_batch_a', tick: 6 }),
          deposit({ sequence: 2, eventKey: 'evt_batch_b', tick: 6 }),
        ]),
      rejectsJournal('SEQUENCE_OUT_OF_ORDER'),
    );
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 1);

    // The first movement of the batch is inserted, then the repeated event key
    // rejects the batch: the insertion must not survive the failure.
    assert.throws(
      () =>
        repos.creditJournal.append(JOURNAL_MATCH_ID, [
          deposit({ sequence: 2, eventKey: 'evt_dup', tick: 6 }),
          deposit({ sequence: 3, eventKey: 'evt_dup', tick: 6 }),
        ]),
      rejectsJournal('DUPLICATE_EVENT_KEY'),
    );
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 1);
    assert.deepEqual(
      repos.creditJournal.list(JOURNAL_MATCH_ID).map((movement) => movement.eventKey),
      ['evt_1'],
    );

    // A duplicate of an already stored key is rejected even for the next sequence.
    assert.throws(
      () =>
        repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 2, eventKey: 'evt_1', tick: 6 })]),
      rejectsJournal('DUPLICATE_EVENT_KEY'),
    );
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 1);
  });
});

test('movements cannot predate the opening, postdate the match tick, or target another match', () => {
  withRepositories((repos) => {
    seedJournalMatch(repos, 10);
    repos.creditJournal.createOpening(sampleCreditOpening({ observedAtTick: 4, coverage: 'CUTOVER' }));

    assert.throws(
      () => repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 1, eventKey: 'evt_past', tick: 3 })]),
      rejectsJournal('TICK_BEFORE_OPENING'),
    );
    assert.throws(
      () => repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 1, eventKey: 'evt_future', tick: 11 })]),
      rejectsJournal('FUTURE_TICK'),
    );
    assert.throws(
      () =>
        repos.creditJournal.append(JOURNAL_MATCH_ID, [
          deposit({ matchId: 'match_other', sequence: 1, eventKey: 'evt_other' }),
        ]),
      rejectsJournal('MATCH_MISMATCH'),
    );
    assert.throws(
      () => repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 2, eventKey: 'evt_skipped', tick: 6 })]),
      rejectsJournal('SEQUENCE_OUT_OF_ORDER'),
    );
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 0);
  });
});

test('movements require an existing opening', () => {
  withRepositories((repos) => {
    seedJournalMatch(repos, 10);
    assert.throws(
      () => repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 1, eventKey: 'evt_no_opening' })]),
      rejectsJournal('OPENING_MISSING'),
    );
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 0);
  });
});

test('a movement for an unpersisted match is rejected', () => {
  withRepositories((repos) => {
    assert.throws(
      () => repos.creditJournal.append('match_missing', [deposit({ matchId: 'match_missing' })]),
      rejectsJournal('MATCH_UNKNOWN'),
    );
  });
});

test('openings reject sinks, duplicate accounts, unsafe balances and unknown coverage', () => {
  withRepositories((repos, database) => {
    seedJournalMatch(repos, 10);
    // Invalid accounts are supplied through a cast: this test is about the
    // runtime rejection, not about the compile-time union.
    const balance = (account: CreditAccountRef, balanceCredits: number) => ({
      account: account as CreditCompanyAccountRef,
      balanceCredits,
    });

    const cases: readonly (readonly [string, Partial<CreditLedgerOpening>, string])[] = [
      ['unknown coverage', { coverage: 'GUESSED' as CreditLedgerOpening['coverage'] }, 'INVALID_COVERAGE'],
      ['negative observed tick', { observedAtTick: -1 }, 'INVALID_TICK'],
      ['fractional observed tick', { observedAtTick: 1.5 }, 'INVALID_TICK'],
      ['balances not a list', { balances: 'nope' as unknown as CreditLedgerOpening['balances'] }, 'INVALID_BALANCES'],
      [
        'sink balance',
        { balances: [balance({ kind: 'MARKET_FEE_SINK' }, 0)] },
        'OPENING_SINK_NOT_ALLOWED',
      ],
      [
        'negative balance',
        { balances: [balance({ kind: 'AVAILABLE', companyId: COMPANY_METAL }, -5)] },
        'INVALID_BALANCE',
      ],
      [
        'fractional balance',
        { balances: [balance({ kind: 'AVAILABLE', companyId: COMPANY_METAL }, 1.5)] },
        'INVALID_BALANCE',
      ],
      [
        'duplicate account',
        {
          balances: [
            balance({ kind: 'AVAILABLE', companyId: COMPANY_METAL }, 10000),
            balance({ kind: 'AVAILABLE', companyId: COMPANY_METAL }, 10000),
          ],
        },
        'DUPLICATE_OPENING_ACCOUNT',
      ],
    ];

    for (const [label, patch, code] of cases) {
      assert.throws(
        () => repos.creditJournal.createOpening(sampleCreditOpening(patch)),
        rejectsValidation(code),
        label,
      );
      assert.equal(countRows(database, 'credit_ledger_openings'), 0, label);
      assert.equal(countRows(database, 'credit_ledger_opening_balances'), 0, label);
    }
  });
});

test('a legacy CUTOVER opening records observed balances and backfills no history', () => {
  withDatabase((database) => {
    migrate(database, LEGACY_MIGRATIONS);
    const repos = createRepositories(database);
    seedCompanies(repos);
    seedJournalMatch(repos, 10);

    const legacyCore = snapshotState(database, CORE_STATE_TABLES);
    assert.deepEqual(migrate(database), { appliedVersions: [7], currentVersion: 7 });

    assert.deepEqual(snapshotState(database, CORE_STATE_TABLES), legacyCore);
    assert.equal(repos.companies.load(COMPANY_METAL)?.credits, 10000);
    assert.equal(repos.companies.load(COMPANY_FACTORY)?.credits, 10000);
    assert.deepEqual(repos.contracts.list(), []);

    for (const table of ['credit_ledger_openings', 'credit_ledger_opening_balances', 'credit_ledger_movements'] as const) {
      assert.equal(countRows(database, table), 0, `${table} must start empty on upgrade`);
    }

    const cutover = repos.creditJournal.createOpening({
      matchId: JOURNAL_MATCH_ID,
      observedAtTick: 10,
      coverage: 'CUTOVER',
      balances: [
        { account: { kind: 'AVAILABLE', companyId: COMPANY_METAL }, balanceCredits: 10000 },
        { account: { kind: 'AVAILABLE', companyId: COMPANY_FACTORY }, balanceCredits: 10000 },
      ],
    });
    assert.equal(cutover.coverage, 'CUTOVER');
    assert.equal(cutover.observedAtTick, 10);
    assert.equal(cutover.balances.length, 2);

    // The opening is evidence of what was observed, never spendable history.
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 0);
    assert.equal(countRows(database, 'credit_ledger_movements'), 0);
    assert.deepEqual(snapshotState(database, CORE_STATE_TABLES), legacyCore);
  });
});

test('migration 7 preserves a populated version-6 database and repeats as a no-op', () => {
  withDatabase((database) => {
    migrate(database, LEGACY_MIGRATIONS);
    const repos = createRepositories(database);
    seedCompanies(repos);
    repos.contracts.save(sampleContract());
    seedJournalMatch(repos, 10);

    const coreBefore = snapshotState(database, CORE_STATE_TABLES);
    const appliedBefore = getAppliedMigrations(database);

    assert.deepEqual(migrate(database), { appliedVersions: [7], currentVersion: 7 });
    assert.deepEqual(getAppliedMigrations(database).slice(0, 6), appliedBefore);
    assert.deepEqual(snapshotState(database, CORE_STATE_TABLES), coreBefore);
    assert.deepEqual(repos.contracts.list(), [sampleContract()]);
    for (const table of JOURNAL_STATE_TABLES) assert.equal(countRows(database, table), 0);

    const applied = getAppliedMigrations(database);
    assert.deepEqual(migrate(database), { appliedVersions: [], currentVersion: 7 });
    assert.deepEqual(getAppliedMigrations(database), applied);
    for (const table of JOURNAL_STATE_TABLES) assert.equal(countRows(database, table), 0);
    assert.deepEqual(snapshotState(database, CORE_STATE_TABLES), coreBefore);
  });
});

test('a failed migration 7 rolls back its tables and version before a clean application', () => {
  withDatabase((database) => {
    migrate(database, LEGACY_MIGRATIONS);
    const repos = createRepositories(database);
    seedCompanies(repos);
    repos.contracts.save(sampleContract());
    seedJournalMatch(repos, 10);

    const coreBefore = snapshotState(database, CORE_STATE_TABLES);
    const appliedBefore = getAppliedMigrations(database);
    const migration = journalMigration();

    assert.throws(
      () =>
        migrate(database, [
          ...LEGACY_MIGRATIONS,
          {
            ...migration,
            sql: `${migration.sql}\nSELECT * FROM deliberately_missing_migration_probe;`,
          },
        ]),
      /MigrationError: migration 7 \(credit_journal\) failed to apply/,
    );

    assert.equal(getCurrentVersion(database), 6);
    assert.deepEqual(getAppliedMigrations(database), appliedBefore);
    assert.deepEqual(snapshotState(database, CORE_STATE_TABLES), coreBefore);
    // The journal tables were created and dropped inside the failed migration.
    for (const table of JOURNAL_STATE_TABLES) {
      assert.throws(() => countRows(database, table), /no such table/);
    }

    assert.deepEqual(migrate(database), { appliedVersions: [7], currentVersion: 7 });
    assert.deepEqual(snapshotState(database, CORE_STATE_TABLES), coreBefore);
    repos.contracts.save({ ...sampleContract(), contractId: 'contract_after_upgrade' });
    assert.equal(repos.contracts.list().length, 2);
  });
});

test('commitExecutions without journal arguments keeps the existing behavior', () => {
  withRepositories((repos, database) => {
    const store = createMatchStore(database, repos);
    const adopted = store.adoptOrCreate({ matchId: JOURNAL_MATCH_ID, seed: 42, tickIntervalMs: 1000 });
    assert.equal(adopted.adopted, false);

    store.commitExecutions({
      metadata: { ...adopted.metadata, currentTick: 1, historyCursor: 1 },
      results: [
        {
          matchId: JOURNAL_MATCH_ID,
          historyIndex: 0,
          commandId: 'cmd_1',
          idempotencyKey: 'key_1',
          executedAtTick: 1,
          success: true,
        },
      ],
      completedCommandIds: [],
    });

    assert.equal(repos.matches.load(JOURNAL_MATCH_ID)?.currentTick, 1);
    assert.equal(repos.commandResults.count(JOURNAL_MATCH_ID), 1);
    assert.equal(repos.creditJournal.getOpening(JOURNAL_MATCH_ID), null);
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 0);
    assert.equal(countRows(database, 'credit_ledger_movements'), 0);
  });
});

test('commitExecutions writes the opening and movements inside its tick transaction', () => {
  withRepositories((repos, database) => {
    const store = createMatchStore(database, repos);
    seedCompanies(repos);
    const adopted = store.adoptOrCreate({ matchId: JOURNAL_MATCH_ID, seed: 42, tickIntervalMs: 1000 });
    assert.equal(adopted.adopted, false);

    const movements: CreditJournalMovementWrite[] = [
      deposit({ sequence: 1, eventKey: 'evt_tick_deposit', tick: 4 }),
      deposit({
        sequence: 2,
        eventKey: 'evt_tick_delivery',
        tick: 5,
        kind: 'DELIVERY_PAYMENT',
        amountCredits: 196,
        source: { kind: 'BUYER_ESCROW', companyId: COMPANY_FACTORY },
        destination: { kind: 'AVAILABLE', companyId: COMPANY_METAL },
      }),
    ];

    store.commitExecutions({
      metadata: { ...adopted.metadata, currentTick: 5, historyCursor: 1 },
      results: [
        {
          matchId: JOURNAL_MATCH_ID,
          historyIndex: 0,
          commandId: 'cmd_tick',
          idempotencyKey: 'key_tick',
          executedAtTick: 5,
          success: true,
        },
      ],
      completedCommandIds: [],
      opening: sampleCreditOpening({ matchId: JOURNAL_MATCH_ID, observedAtTick: 0 }),
      movements,
    });

    assert.equal(repos.matches.load(JOURNAL_MATCH_ID)?.currentTick, 5);
    assert.equal(repos.matches.load(JOURNAL_MATCH_ID)?.historyCursor, 1);
    assert.deepEqual(repos.creditJournal.getOpening(JOURNAL_MATCH_ID), {
      ...sampleCreditOpening({ matchId: JOURNAL_MATCH_ID }),
      openedAtUtc: repos.creditJournal.getOpening(JOURNAL_MATCH_ID)?.openedAtUtc,
    });
    assert.deepEqual(
      repos.creditJournal.list(JOURNAL_MATCH_ID).map(({ recordedAtUtc: _recordedAtUtc, ...rest }) => rest),
      movements,
    );
    assert.equal(repos.commandResults.count(JOURNAL_MATCH_ID), 1);
  });
});

test('a rejected settlement batch rolls back the tick metadata, history and journal rows', () => {
  withRepositories((repos, database) => {
    const store = createMatchStore(database, repos);
    seedCompanies(repos);
    const adopted = store.adoptOrCreate({ matchId: JOURNAL_MATCH_ID, seed: 42, tickIntervalMs: 1000 });
    const before = snapshotState(database);
    const metadataBefore = repos.matches.load(JOURNAL_MATCH_ID);

    assert.throws(
      () =>
        store.commitExecutions({
          metadata: { ...adopted.metadata, currentTick: 5, historyCursor: 2 },
          results: [
            {
              matchId: JOURNAL_MATCH_ID,
              historyIndex: 0,
              commandId: 'cmd_rollback',
              idempotencyKey: 'key_rollback',
              executedAtTick: 5,
              success: true,
            },
          ],
          completedCommandIds: [],
          opening: sampleCreditOpening({ matchId: JOURNAL_MATCH_ID }),
          movements: [
            deposit({ sequence: 1, eventKey: 'evt_repeat', tick: 4 }),
            deposit({ sequence: 2, eventKey: 'evt_repeat', tick: 5 }),
          ],
        }),
      rejectsJournal('DUPLICATE_EVENT_KEY'),
    );

    assert.deepEqual(snapshotState(database), before);
    assert.deepEqual(repos.matches.load(JOURNAL_MATCH_ID), metadataBefore);
    assert.equal(repos.commandResults.count(JOURNAL_MATCH_ID), 0);
    assert.equal(repos.creditJournal.getOpening(JOURNAL_MATCH_ID), null);
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 0);
    assert.equal(countRows(database, 'credit_ledger_openings'), 0);
    assert.deepEqual(repos.companies.load(COMPANY_METAL), sampleCompanyState());
  });
});

test('a journal batch composed with a credit debit rolls back together', () => {
  withRepositories((repos, database) => {
    seedCompanies(repos);
    seedJournalMatch(repos, 10);
    const before = snapshotState(database);
    const creditsBefore = repos.companies.load(COMPANY_FACTORY)?.credits;

    assert.throws(
      () =>
        runAtomic(database, () => {
          repos.creditJournal.createOpening(sampleCreditOpening());
          repos.creditJournal.append(JOURNAL_MATCH_ID, [deposit({ sequence: 1, eventKey: 'evt_atomic' })]);
          database
            .query('UPDATE companies SET credits = credits - 600 WHERE company_id = ?')
            .run(COMPANY_FACTORY);
          throw new Error('induced settlement failure');
        }),
      /induced settlement failure/,
    );

    assert.deepEqual(snapshotState(database), before);
    assert.equal(repos.companies.load(COMPANY_FACTORY)?.credits, creditsBefore);
    assert.equal(repos.creditJournal.getOpening(JOURNAL_MATCH_ID), null);
    assert.equal(repos.creditJournal.count(JOURNAL_MATCH_ID), 0);
  });
});
