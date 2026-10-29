/** S4/S14: schema and immutable, validated journal openings. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CreditLedgerValidationError, type CreditAccountRef, type CreditCompanyAccountRef, type CreditLedgerOpening } from '../../src/domain/creditLedger.ts';
import { MIGRATIONS, getAppliedMigrations, getCurrentVersion, migrate } from '../../src/persistence/migrations.ts';
import { CreditJournalError, createRepositories } from '../../src/persistence/repos/index.ts';
import { COMPANY_FACTORY, COMPANY_METAL, CORE_STATE_TABLES, JOURNAL_STATE_TABLES, JOURNAL_MATCH_ID, countRows, sampleContract, sampleCreditOpening, seedCompanies, seedJournalMatch, snapshotState, withDatabase, withRepositories } from './repos-fixtures.ts';

/** Versions 1-6: a database written before the credit journal existed. */
const LEGACY_MIGRATIONS = MIGRATIONS.filter((migration) => migration.version <= 6);

function journalMigration() {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 7);
  assert.ok(migration, 'the credit-journal storage migration must be registered as version 7');
  return migration;
}

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
