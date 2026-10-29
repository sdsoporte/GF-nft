import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, closeDatabase } from '../../src/persistence/database.ts';
import { MIGRATIONS, migrate, getAppliedMigrations, getCurrentVersion } from '../../src/persistence/migrations.ts';
import { createRepositories } from '../../src/persistence/repos/index.ts';
import type { SupplyContract } from '../../src/domain/types.ts';
import { createAcceptedContract } from '../engine/contracts-helpers.ts';

const legacy = MIGRATIONS.filter(migration => migration.version <= 5);
/** Versions 1-6: a database at the DRAFT-schema version, before the journal. */
const draftEra = MIGRATIONS.filter(migration => migration.version <= 6);
function fixture(repositories: ReturnType<typeof createRepositories>): SupplyContract {
  const { engine, contractId } = createAcceptedContract({ quantity: 10, unitPriceCredits: 50, deadlineTicks: 100 });
  for (const company of Object.values(engine.createSnapshot().companies)) repositories.saveCompanyState(company);
  return structuredClone(engine.getContract(contractId)!);
}
function saveLegacy(repositories: ReturnType<typeof createRepositories>) {
  const contract = fixture(repositories);
  for (const status of ['PENDING', 'ACTIVE', 'FULFILLED', 'DEFAULTED', 'CANCELLED'] as const) {
    repositories.contracts.save({ ...contract, contractId: `legacy_${status}`, status,
      deliveredQuantity: status === 'FULFILLED' ? contract.totalQuantity : 4,
      ...(['FULFILLED', 'DEFAULTED', 'CANCELLED'].includes(status) ? { settledAtTick: 9 } : {}),
    });
  }
  return contract;
}

test('fresh migrated storage round-trips DRAFT through the contract repository', () => {
  const database = openDatabase(':memory:');
  try {
    migrate(database);
    const repositories = createRepositories(database);
    const draft: SupplyContract = { ...fixture(repositories), contractId: 'fresh_draft', status: 'DRAFT' };
    repositories.contracts.save(draft);
    assert.deepEqual(repositories.contracts.load(draft.contractId), draft);
    assert.deepEqual(repositories.contracts.list({ status: 'DRAFT' }), [draft]);
    // The registry now ends at version 7 (credit journal, additive). Version 6
    // remains the DRAFT schema delta asserted by this file.
    assert.equal(getCurrentVersion(database), MIGRATIONS.at(-1)!.version);
    assert.equal(draftEra.at(-1)!.version, 6);
  } finally { closeDatabase(database); }
});

test('v5 upgrade preserves all legacy contract values and constraints and repeats as a no-op', () => {
  const database = openDatabase(':memory:');
  try {
    migrate(database, legacy);
    const repositories = createRepositories(database);
    const contract = saveLegacy(repositories);
    const before = repositories.contracts.list();
    const appliedBefore = getAppliedMigrations(database);
    assert.deepEqual(migrate(database), { appliedVersions: [6, 7], currentVersion: 7 });
    assert.deepEqual(repositories.contracts.list(), before);
    assert.deepEqual(getAppliedMigrations(database).slice(0, 5), appliedBefore);
    const draft: SupplyContract = { ...contract, contractId: 'upgrade_draft', status: 'DRAFT' };
    repositories.contracts.save(draft);
    assert.deepEqual(repositories.contracts.load(draft.contractId), draft);
    const all = repositories.contracts.list();
    for (const override of [{ status: 'INVALID' }, { totalQuantity: 0 }, { deliveredQuantity: -1 },
      { unitPriceCredits: 0 }, { totalValueCredits: 0 }, { collateralSellerCredits: -1 },
      { deadlineTick: draft.createdAtTick }, { sellerCompanyId: 'missing_seller' }]) {
      assert.throws(() => repositories.contracts.save({ ...draft, ...override } as SupplyContract), /CHECK|FOREIGN KEY/);
      assert.deepEqual(repositories.contracts.list(), all);
    }
    const applied = getAppliedMigrations(database);
    assert.deepEqual(migrate(database), { appliedVersions: [], currentVersion: 7 });
    assert.deepEqual(repositories.contracts.list(), all);
    assert.deepEqual(getAppliedMigrations(database), applied);
  } finally { closeDatabase(database); }
});

test('failed DRAFT migration rolls back table replacement and version before a clean application', () => {
  const database = openDatabase(':memory:');
  try {
    migrate(database, legacy);
    const repositories = createRepositories(database);
    const contract = saveLegacy(repositories);
    const before = repositories.contracts.list();
    const applied = getAppliedMigrations(database);
    const migration = MIGRATIONS.find(migration => migration.version === 6);
    assert.ok(migration, 'DRAFT storage migration must be registered as version 6');
    assert.throws(() => migrate(database, [...legacy, { ...migration,
      sql: `${migration.sql}\nSELECT * FROM deliberately_missing_migration_probe;`,
    }]), /migration 6 .*failed to apply/);
    assert.equal(getCurrentVersion(database), 5);
    assert.deepEqual(getAppliedMigrations(database), applied);
    assert.deepEqual(repositories.contracts.list(), before);
    assert.throws(() => repositories.contracts.save({ ...contract, contractId: 'rolled_back_draft', status: 'DRAFT' }), /CHECK/);
    assert.deepEqual(repositories.contracts.list(), before);
    assert.deepEqual(migrate(database), { appliedVersions: [6, 7], currentVersion: 7 });
    assert.deepEqual(repositories.contracts.list(), before);
  } finally { closeDatabase(database); }
});
