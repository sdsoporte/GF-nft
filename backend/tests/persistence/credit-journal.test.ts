/** S4/S14: additive journal schema, preserved legacy rows, no audit backfill. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MIGRATIONS, getAppliedMigrations, getCurrentVersion, migrate } from '../../src/persistence/migrations.ts';
import { createRepositories } from '../../src/persistence/repos/index.ts';
import { CORE_STATE_TABLES, JOURNAL_STATE_TABLES, countRows, sampleContract, seedCompanies, seedJournalMatch, snapshotState, withDatabase } from './repos-fixtures.ts';

/** Versions 1-6: a database written before the credit journal existed. */
const LEGACY_MIGRATIONS = MIGRATIONS.filter((migration) => migration.version <= 6);

function journalMigration() {
  const migration = MIGRATIONS.find((candidate) => candidate.version === 7);
  assert.ok(migration, 'the credit-journal storage migration must be registered as version 7');
  return migration;
}

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
