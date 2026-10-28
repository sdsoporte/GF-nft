/**
 * Migration 2 — recovery columns and the reservation uniqueness indexes.
 *
 * T1 flagged two columns as required for exact recovery but absent from version
 * 1 (`matches.tick_interval_ms`, `companies.maintenance_paid_ticks`). This file
 * proves version 2 applies to a fresh database *and* upgrades a database that
 * only ever ran version 1 (the T1-era path), without touching its rows.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Database } from 'bun:sqlite';

import {
  MIGRATIONS,
  getAppliedMigrations,
  getCurrentVersion,
  migrate,
} from '../../src/persistence/migrations.ts';
import { withDatabase } from './repos-fixtures.ts';

function listColumns(database: Database, table: string): string[] {
  const rows = database.query<{ name: string }>(`PRAGMA table_info(${table})`).all();
  return rows.map((row) => row.name);
}

function listIndexes(database: Database, table: string): string[] {
  const rows = database
    .query<{ name: string }>(`PRAGMA index_list(${table})`)
    .all();
  return rows.map((row) => row.name);
}

test('migration 2 applies after version 1 on a fresh database', () => {
  withDatabase((database) => {
    const run = migrate(database);

    assert.deepEqual(run.appliedVersions, [1, 2]);
    assert.equal(run.currentVersion, 2);
    assert.deepEqual(
      getAppliedMigrations(database).map((migration) => migration.name),
      ['initial', 'recovery_columns'],
    );

    assert.equal(listColumns(database, 'matches').includes('tick_interval_ms'), true);
    assert.equal(
      listColumns(database, 'companies').includes('maintenance_paid_ticks'),
      true,
    );
    assert.equal(listIndexes(database, 'inventory_reservations').includes('ux_reservations_lot'), true);
    assert.equal(listIndexes(database, 'commodity_lots').includes('ux_lots_reservation'), true);
  });
});

test('migration 2 upgrades a version-1 database and backfills the new defaults', () => {
  withDatabase((database) => {
    // Simulate a T1-era database: only version 1 has ever been applied.
    const first = migrate(database, [MIGRATIONS[0]]);
    assert.deepEqual(first.appliedVersions, [1]);
    assert.equal(listColumns(database, 'matches').includes('tick_interval_ms'), false);

    database
      .query(
        `INSERT INTO companies (company_id, name, industrial_class, created_at_utc, updated_at_utc)
         VALUES ('comp_metal_01', 'Metal One', 'CLASS_A_METALLURGY',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    database
      .query(
        `INSERT INTO matches (match_id, seed, created_at_utc, updated_at_utc)
         VALUES ('match_test', 42107, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const upgrade = migrate(database);

    assert.deepEqual(upgrade.appliedVersions, [2]);
    assert.equal(getCurrentVersion(database), 2);

    const company = database
      .query<{ credits: number; maintenance_paid_ticks: number }>(
        'SELECT credits, maintenance_paid_ticks FROM companies WHERE company_id = ?',
      )
      .get('comp_metal_01');
    assert.equal(company?.credits, 10000);
    assert.equal(company?.maintenance_paid_ticks, 0);

    const match = database
      .query<{ seed: number; tick_interval_ms: number }>(
        'SELECT seed, tick_interval_ms FROM matches WHERE match_id = ?',
      )
      .get('match_test');
    assert.equal(match?.seed, 42107);
    assert.equal(match?.tick_interval_ms, 1000);
  });
});

test('migration 2 is a no-op on an already upgraded database', () => {
  withDatabase((database) => {
    migrate(database);
    const rerun = migrate(database);

    assert.deepEqual(rerun.appliedVersions, []);
    assert.equal(rerun.currentVersion, 2);
    assert.equal(getAppliedMigrations(database).length, 2);
  });
});

test('migration 2 keeps version 1 intact and is the only schema delta', () => {
  withDatabase((database) => {
    migrate(database, [MIGRATIONS[0]]);
    const tablesBefore = database
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    migrate(database);

    const tablesAfter = database
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    assert.deepEqual(tablesAfter, tablesBefore);
  });
});
