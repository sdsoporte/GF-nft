/**
 * Versioned migration runner (S3).
 *
 * Bookkeeping choice: applied versions are recorded in a dedicated
 * `schema_migrations` table, not in `PRAGMA user_version`. A table keeps one
 * auditable row per migration (version, name, timestamp), so a database can be
 * inspected for what ran and when, and an `INTEGER PRIMARY KEY` on the version
 * makes "applied exactly once" a database constraint rather than a convention.
 *
 * Guarantees:
 * - migrations apply in ascending version order, versions strictly 1..N (no
 *   duplicates, no gaps, no reordering);
 * - each migration's DDL and its bookkeeping row commit together, so a broken
 *   migration rolls back completely and can be fixed and reapplied;
 * - re-running on an up-to-date database is a no-op (idempotent on re-open);
 * - a database that already ran a version the code does not know, or whose
 *   applied set is not a prefix of the supplied list, is rejected loudly.
 */

import type { Database } from 'bun:sqlite';

import { withTransaction } from './database.ts';
import { INITIAL_MIGRATION } from './migrations/001_initial.ts';
import { RECOVERY_COLUMNS_MIGRATION } from './migrations/002_recovery_columns.ts';
import { SETTLEMENT_BOOKKEEPING_MIGRATION } from './migrations/003_settlement_bookkeeping.ts';
import { COMMAND_RESULT_TENANT_MIGRATION } from './migrations/004_command_result_tenant.ts';
import { MCP_GRANT_TOKEN_HASH_MIGRATION } from './migrations/005_mcp_grant_token_hash.ts';
import { CONTRACT_DRAFT_STATUS_MIGRATION } from './migrations/006_contract_draft_status.ts';
import { CREDIT_JOURNAL_MIGRATION } from './migrations/007_credit_journal.ts';
import { MCP_POLICY_EVENTS_MIGRATION } from './migrations/008_mcp_policy_events.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAtUtc: string;
}

export interface MigrationRun {
  /** Versions applied by this call, ascending; empty when already current. */
  readonly appliedVersions: readonly number[];
  /** Highest applied version after the call (0 for an empty schema). */
  readonly currentVersion: number;
}

/** Raised for every rejection the runner performs; message names the reason. */
export class MigrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

const SCHEMA_MIGRATIONS_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    applied_at_utc TEXT NOT NULL
)`;

const INSERT_MIGRATION_SQL =
  'INSERT INTO schema_migrations (version, name, applied_at_utc) VALUES (?, ?, ?)';

const SELECT_APPLIED_SQL =
  'SELECT version, name, applied_at_utc FROM schema_migrations ORDER BY version ASC';

/** The ordered migrations owned by this codebase. Append new versions only. */
export const MIGRATIONS: readonly Migration[] = [
  INITIAL_MIGRATION,
  RECOVERY_COLUMNS_MIGRATION,
  SETTLEMENT_BOOKKEEPING_MIGRATION,
  COMMAND_RESULT_TENANT_MIGRATION,
  MCP_GRANT_TOKEN_HASH_MIGRATION,
  CONTRACT_DRAFT_STATUS_MIGRATION,
  CREDIT_JOURNAL_MIGRATION,
  MCP_POLICY_EVENTS_MIGRATION,
];

interface AppliedRow {
  readonly version: number;
  readonly name: string;
  readonly applied_at_utc: string;
}

function ensureBookkeepingTable(database: Database): void {
  database.exec(SCHEMA_MIGRATIONS_SQL);
}

/**
 * Reject a migration list that cannot be applied in order. Failures here are
 * programming/merge errors, so they throw before touching the database.
 */
function validateDefinitions(migrations: readonly Migration[]): void {
  if (migrations.length === 0) {
    throw new MigrationError('MigrationError: no migrations were provided');
  }
  const seen = new Set<number>();
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (!Number.isInteger(migration.version) || migration.version !== expected) {
      throw new MigrationError(
        `MigrationError: migration at position ${index + 1} must have version ${expected}, ` +
          `received ${String(migration.version)} (versions must be strictly ascending from 1)`,
      );
    }
    if (seen.has(migration.version)) {
      throw new MigrationError(
        `MigrationError: duplicate migration version ${migration.version}`,
      );
    }
    if (typeof migration.name !== 'string' || migration.name.trim().length === 0) {
      throw new MigrationError(
        `MigrationError: migration ${migration.version} must have a non-empty name`,
      );
    }
    if (typeof migration.sql !== 'string' || migration.sql.trim().length === 0) {
      throw new MigrationError(
        `MigrationError: migration ${migration.version} must have non-empty SQL`,
      );
    }
    seen.add(migration.version);
  });
}

/** Reject a database whose applied set is not the prefix implied by `migrations`. */
function validateApplied(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[],
): void {
  const known = new Map(migrations.map((migration) => [migration.version, migration]));
  applied.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new MigrationError(
        `MigrationError: applied migrations are not a prefix of the supplied list: ` +
          `position ${index + 1} holds version ${migration.version}`,
      );
    }
    if (!known.has(migration.version)) {
      throw new MigrationError(
        `MigrationError: database reports applied migration ${migration.version} ` +
          `(${migration.name}) which is not in the supplied migration list`,
      );
    }
  });
  if (applied.length > migrations.length) {
    const unknown = applied
      .slice(migrations.length)
      .map((migration) => migration.version)
      .join(', ');
    throw new MigrationError(
      `MigrationError: database is ahead of this build; unknown applied versions: ${unknown}`,
    );
  }
}

/** Applied migrations, ascending. Creates the bookkeeping table when absent. */
export function getAppliedMigrations(database: Database): AppliedMigration[] {
  ensureBookkeepingTable(database);
  return database
    .query<AppliedRow>(SELECT_APPLIED_SQL)
    .all()
    .map((row) => ({
      version: row.version,
      name: row.name,
      appliedAtUtc: row.applied_at_utc,
    }));
}

/** Highest applied version, or 0 when the database has no schema yet. */
export function getCurrentVersion(database: Database): number {
  const applied = getAppliedMigrations(database);
  return applied.length === 0 ? 0 : applied[applied.length - 1].version;
}

/**
 * Apply every pending migration in order and report what this call changed.
 * Each migration commits atomically with its bookkeeping row.
 */
export function migrate(
  database: Database,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationRun {
  validateDefinitions(migrations);
  const applied = getAppliedMigrations(database);
  validateApplied(applied, migrations);

  const appliedVersions = new Set(applied.map((migration) => migration.version));
  const appliedNow: number[] = [];
  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    const appliedAtUtc = new Date().toISOString();
    try {
      withTransaction(database, () => {
        database.exec(migration.sql);
        database.query(INSERT_MIGRATION_SQL).run(migration.version, migration.name, appliedAtUtc);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MigrationError(
        `MigrationError: migration ${migration.version} (${migration.name}) failed to apply: ${reason}`,
        { cause: error },
      );
    }
    appliedNow.push(migration.version);
  }

  return { appliedVersions: appliedNow, currentVersion: getCurrentVersion(database) };
}
