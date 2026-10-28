/**
 * SQLite connection module (A1: `bun:sqlite` only, no Node-only driver).
 *
 * Responsibilities are deliberately narrow: open a file-backed database with
 * the connection pragmas the domain invariants rely on, expose one atomic
 * transaction helper, and close deterministically. Creating the parent
 * directory of the database file belongs to boot, not here, so that a bad
 * `GF_SQLITE_PATH` fails at startup instead of silently writing elsewhere.
 */

import { Database } from 'bun:sqlite';

/**
 * WAL keeps one writer and many readers without losing committed work on a
 * process restart; `busy_timeout` makes concurrent writers wait instead of
 * failing with SQLITE_BUSY (risk item 4). `synchronous = NORMAL` is durable
 * for process restarts (the S6/S5 acceptance), not for power loss, which is out
 * of scope for a single-container match server.
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenDatabaseOptions {
  /** Milliseconds a blocked writer waits for the lock before failing. */
  readonly busyTimeoutMs?: number;
}

/**
 * Open (creating when absent) the database file at `path`.
 * Throws when the path is empty: configuration is validated earlier, so an
 * empty path here is a programming error, never a silent fallback.
 */
export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Database {
  const trimmed = typeof path === 'string' ? path.trim() : '';
  if (trimmed.length === 0) {
    throw new Error('openDatabase requires a non-empty database path');
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error('openDatabase requires a non-negative integer busyTimeoutMs');
  }

  const database = new Database(trimmed, { create: true });
  // Foreign keys are off by default in SQLite and the schema relies on them.
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA synchronous = NORMAL');
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  return database;
}

/** Close a database handle; safe to call once per `openDatabase`. */
export function closeDatabase(database: Database): void {
  database.close();
}

/**
 * Run `work` inside one atomic transaction: commit on return, roll back on
 * throw. Not re-entrant by design, so a failing unit of work can never leave
 * partially written rows (S4/S7).
 */
export function withTransaction<T>(database: Database, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = work();
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // A failed rollback must not mask the original failure.
    }
    throw error;
  }
  database.exec('COMMIT');
  return result;
}
