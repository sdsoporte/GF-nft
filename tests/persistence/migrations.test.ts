/**
 * SQLite foundation: connection module, versioned migration runner and
 * schema version 1 (the documented `src/persistence/schema.sql` base plus the
 * A8 deltas: command queue, processed idempotency keys, ack ledger, match
 * metadata, execution/command-result rows and line `activeBatch` fields).
 *
 * Every test uses its own temporary database file and removes it afterwards.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { Database } from 'bun:sqlite';

import { closeDatabase, openDatabase, withTransaction } from '../../src/persistence/database.ts';
import {
  MIGRATIONS,
  getAppliedMigrations,
  getCurrentVersion,
  migrate,
  type Migration,
} from '../../src/persistence/migrations.ts';

/** Runs `work` against a unique database path and deletes the temp directory. */
function withTempDatabase(work: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'gf-sqlite-'));
  try {
    work(join(directory, 'factory.db'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function listTables(database: Database): string[] {
  const rows = database
    .query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}

function listColumns(database: Database, table: string): string[] {
  const rows = database.query<{ name: string }>(`PRAGMA table_info(${table})`).all();
  return rows.map((row) => row.name);
}

/** Table name -> declared column names, parsed from the documented schema file. */
function readDocumentedSchema(): Map<string, string[]> {
  const source = readFileSync(new URL('../../src/persistence/schema.sql', import.meta.url), 'utf8');
  const tables = new Map<string, string[]>();
  const tablePattern = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  const columnPattern = /^\s+([a-z][a-z0-9_]*)\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC)\b/i;
  const reserved = /^\s*(?:CHECK|UNIQUE|FOREIGN|PRIMARY|CONSTRAINT)\b/i;
  for (const match of source.matchAll(tablePattern)) {
    const [, name, body] = match;
    const columns: string[] = [];
    for (const line of body.split('\n')) {
      if (reserved.test(line)) continue;
      const column = columnPattern.exec(line);
      if (column) columns.push(column[1]);
    }
    tables.set(name, columns);
  }
  return tables;
}

/** Version 1 must contain every table documented by `schema.sql`. */
const DOCUMENTED_TABLES = [
  'companies',
  'inventories',
  'production_lines',
  'b2b_contracts',
  'inventory_reservations',
  'commodity_lots',
  'trade_escrows',
  'usage_rights',
  'mcp_grants',
  'mcp_audit_logs',
  'match_telemetry',
];

/** The A8 delta owned by version 1. */
const DELTA_TABLES = [
  'matches',
  'match_command_queue',
  'match_processed_idempotency_keys',
  'match_ack_ledger',
  'match_command_results',
];

const ACTIVE_BATCH_COLUMNS = [
  'active_batch_recipe_id',
  'active_batch_target_batches',
  'active_batch_completed_batches',
  'active_batch_progress_ticks',
  'active_batch_total_duration_ticks',
  'active_batch_energy_per_tick',
  'active_batch_energy_remainder',
];

function insertMatch(database: Database, matchId = 'match_test'): void {
  database
    .query(
      `INSERT INTO matches (match_id, seed, current_tick, sequence_counter, history_cursor,
         created_at_utc, updated_at_utc)
       VALUES (?, ?, 0, 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(matchId, 42107);
}

// --- connection module -------------------------------------------------------

test('the connection module opens a file database with safe pragmas', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      const foreignKeys = database.query<{ foreign_keys: number }>('PRAGMA foreign_keys').get();
      assert.equal(foreignKeys?.foreign_keys, 1);
      const journalMode = database.query<{ journal_mode: string }>('PRAGMA journal_mode').get();
      assert.equal(journalMode?.journal_mode, 'wal');
      assert.equal(database.query<{ name: string }>('SELECT name FROM sqlite_master').all().length, 0);
    } finally {
      closeDatabase(database);
    }
  });
});

test('the connection module rejects an empty path instead of guessing one', () => {
  assert.throws(() => openDatabase('   '), /non-empty database path/);
});

test('withTransaction commits on success and rolls back on failure', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      database.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');

      withTransaction(database, () => {
        database.query('INSERT INTO probe (id) VALUES (?)').run('committed');
      });
      assert.deepEqual(
        database.query<{ id: string }>('SELECT id FROM probe ORDER BY id').all().map((row) => row.id),
        ['committed'],
      );

      assert.throws(
        () =>
          withTransaction(database, () => {
            database.query('INSERT INTO probe (id) VALUES (?)').run('rolled_back');
            throw new Error('boom');
          }),
        /boom/,
      );
      assert.deepEqual(
        database.query<{ id: string }>('SELECT id FROM probe ORDER BY id').all().map((row) => row.id),
        ['committed'],
      );
    } finally {
      closeDatabase(database);
    }
  });
});

// --- versioned migration runner ---------------------------------------------

test('migrate applies every registered migration to a fresh database', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      const run = migrate(database);
      assert.deepEqual(run.appliedVersions, MIGRATIONS.map((migration) => migration.version));
      assert.equal(run.currentVersion, MIGRATIONS.at(-1)!.version);
      assert.equal(getCurrentVersion(database), MIGRATIONS.at(-1)!.version);

      const applied = getAppliedMigrations(database);
      assert.equal(applied.length, MIGRATIONS.length);
      assert.equal(applied[0].version, 1);
      assert.equal(applied[0].name, 'initial');
      assert.match(applied[0].appliedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      closeDatabase(database);
    }
  });
});

test('version 1 covers every table documented by schema.sql', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database);
      const tables = new Set(listTables(database));
      for (const table of DOCUMENTED_TABLES) {
        assert.equal(tables.has(table), true, `version 1 is missing documented table ${table}`);
      }
      for (const [table, documentedColumns] of readDocumentedSchema()) {
        assert.equal(tables.has(table), true, `schema.sql table ${table} is absent from version 1`);
        const columns = new Set(listColumns(database, table));
        for (const column of documentedColumns) {
          assert.equal(
            columns.has(column),
            true,
            `version 1 dropped schema.sql column ${table}.${column}`,
          );
        }
      }
    } finally {
      closeDatabase(database);
    }
  });
});

test('version 1 records the A8 match-persistence delta', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database);
      const tables = new Set(listTables(database));
      for (const table of DELTA_TABLES) {
        assert.equal(tables.has(table), true, `version 1 is missing delta table ${table}`);
      }

      const lineColumns = new Set(listColumns(database, 'production_lines'));
      for (const column of ACTIVE_BATCH_COLUMNS) {
        assert.equal(
          lineColumns.has(column),
          true,
          `production_lines is missing activeBatch column ${column}`,
        );
      }

      const matchColumns = new Set(listColumns(database, 'matches'));
      for (const column of [
        'match_id',
        'seed',
        'current_tick',
        'sequence_counter',
        'history_cursor',
      ]) {
        assert.equal(matchColumns.has(column), true, `matches is missing column ${column}`);
      }
    } finally {
      closeDatabase(database);
    }
  });
});

test('the command queue keeps a polymorphic payload and rejects duplicate idempotency keys', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database);
      insertMatch(database);
      const insert = database.query(
        `INSERT INTO match_command_queue (command_id, match_id, company_id, sequence_number,
           scheduled_tick, idempotency_key, command_type, payload_json, created_at_utc)
         VALUES (?, 'match_test', 'comp_metal_01', ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      );
      insert.run('cmd_1', 1, 1, 'http:match_test:req-1', 'SET_PRODUCTION_TARGET', '{"lineId":"line_1"}');

      const row = database
        .query<{ payload_json: string; scheduled_tick: number }>(
          'SELECT payload_json, scheduled_tick FROM match_command_queue WHERE command_id = ?',
        )
        .get('cmd_1');
      assert.deepEqual(JSON.parse(row?.payload_json ?? '{}'), { lineId: 'line_1' });
      assert.equal(row?.scheduled_tick, 1);

      assert.throws(
        () =>
          insert.run(
            'cmd_2',
            2,
            1,
            'http:match_test:req-1',
            'SET_PRODUCTION_TARGET',
            '{"lineId":"line_1"}',
          ),
        /UNIQUE/,
      );
    } finally {
      closeDatabase(database);
    }
  });
});

test('the ack ledger and processed keys are unique per match and enforce their foreign key', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database);
      insertMatch(database);
      const insertAck = database.query(
        `INSERT INTO match_ack_ledger (match_id, request_id, fingerprint, command_id, acknowledged_at_utc)
         VALUES ('match_test', ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      );
      insertAck.run('req-1', 'line_1\nR1', 'cmd_1');
      assert.throws(() => insertAck.run('req-1', 'line_1\nR1', 'cmd_1'), /UNIQUE/);

      const insertKey = database.query(
        `INSERT INTO match_processed_idempotency_keys (match_id, idempotency_key, command_id, processed_at_utc)
         VALUES ('match_test', ?, ?, '2026-01-01T00:00:00.000Z')`,
      );
      insertKey.run('http:match_test:req-1', 'cmd_1');
      assert.throws(() => insertKey.run('http:match_test:req-1', 'cmd_1'), /UNIQUE/);

      assert.throws(
        () =>
          database
            .query(
              `INSERT INTO match_ack_ledger (match_id, request_id, fingerprint, command_id, acknowledged_at_utc)
               VALUES ('match_missing', 'req-9', 'x', 'cmd_9', '2026-01-01T00:00:00.000Z')`,
            )
            .run(),
        /FOREIGN KEY/,
      );
    } finally {
      closeDatabase(database);
    }
  });
});

test('production_lines rejects a partially filled activeBatch', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database);
      database
        .query(
          `INSERT INTO companies (company_id, name, industrial_class, created_at_utc, updated_at_utc)
           VALUES ('comp_metal_01', 'Metal One', 'CLASS_A_METALLURGY',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();

      const insert = database.query(
        `INSERT INTO production_lines (line_id, company_id, active_batch_recipe_id, active_batch_target_batches)
         VALUES (?, 'comp_metal_01', ?, ?)`,
      );
      assert.throws(() => insert.run('line_partial', 'R1', 2), /CHECK/);

      database
        .query(
          `INSERT INTO production_lines (line_id, company_id, active_batch_recipe_id,
             active_batch_target_batches, active_batch_completed_batches, active_batch_progress_ticks,
             active_batch_total_duration_ticks, active_batch_energy_per_tick, active_batch_energy_remainder)
           VALUES ('line_full', 'comp_metal_01', 'R1', 2, 1, 3, 10, 4, 0)`,
        )
        .run();
      const row = database
        .query<{ active_batch_recipe_id: string; active_batch_progress_ticks: number }>(
          'SELECT active_batch_recipe_id, active_batch_progress_ticks FROM production_lines WHERE line_id = ?',
        )
        .get('line_full');
      assert.equal(row?.active_batch_recipe_id, 'R1');
      assert.equal(row?.active_batch_progress_ticks, 3);
    } finally {
      closeDatabase(database);
    }
  });
});

test('migrate is idempotent when the database is reopened', () => {
  withTempDatabase((path) => {
    const first = openDatabase(path);
    let tablesAfterFirstRun: string[] = [];
    try {
      migrate(first);
      tablesAfterFirstRun = listTables(first);
    } finally {
      closeDatabase(first);
    }

    const second = openDatabase(path);
    try {
      const run = migrate(second);
      assert.deepEqual(run.appliedVersions, []);
      assert.equal(run.currentVersion, MIGRATIONS.at(-1)!.version);
      assert.deepEqual(listTables(second), tablesAfterFirstRun);
      assert.equal(getAppliedMigrations(second).length, MIGRATIONS.length);
    } finally {
      closeDatabase(second);
    }
  });
});

test('migrate refuses migrations that are out of order, duplicated or gapped', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      const noop = (version: number): Migration => ({
        version,
        name: `migration_${version}`,
        sql: `CREATE TABLE probe_${version} (id TEXT PRIMARY KEY)`,
      });

      for (const migrations of [
        [noop(2), noop(1)],
        [noop(1), noop(1)],
        [noop(1), noop(3)],
        [noop(0)],
        [],
      ]) {
        assert.throws(
          () => migrate(database, migrations),
          /MigrationError/,
          `expected ${JSON.stringify(migrations.map((m) => m.version))} to be rejected`,
        );
      }
      assert.deepEqual(listTables(database), []);
    } finally {
      closeDatabase(database);
    }
  });
});

test('migrate refuses a database that already ran an unknown migration', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database);
      assert.throws(() => migrate(database, []), /MigrationError/);
      assert.throws(
        () =>
          migrate(database, [
            { version: 2, name: 'later', sql: 'CREATE TABLE probe_2 (id TEXT PRIMARY KEY)' },
          ]),
        /MigrationError/,
      );
      assert.equal(getCurrentVersion(database), MIGRATIONS.at(-1)!.version);
    } finally {
      closeDatabase(database);
    }
  });
});

test('a broken migration fails loudly and leaves no partial state behind', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      const broken: Migration[] = [
        MIGRATIONS[0],
        {
          version: 2,
          name: 'broken',
          sql: 'CREATE TABLE half_written (id TEXT PRIMARY KEY); CREATE TABLE oops (',
        },
      ];
      assert.throws(() => migrate(database, broken), /MigrationError/);
      assert.equal(getCurrentVersion(database), 1);
      assert.equal(listTables(database).includes('half_written'), false);

      const repaired = migrate(database, [
        MIGRATIONS[0],
        { version: 2, name: 'repaired', sql: 'CREATE TABLE cleaned (id TEXT PRIMARY KEY)' },
      ]);
      assert.deepEqual(repaired.appliedVersions, [2]);
      assert.equal(repaired.currentVersion, 2);
      assert.equal(listTables(database).includes('cleaned'), true);
    } finally {
      closeDatabase(database);
    }
  });
});
