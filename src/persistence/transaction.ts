/**
 * Nested-safe atomic work (S4/S7).
 *
 * `withTransaction` in `database.ts` is intentionally non-reentrant: a nested
 * `BEGIN` is an error in SQLite, and silently committing an inner unit would
 * break the "all or nothing" guarantee. Repositories nonetheless have to
 * compose (a settlement touches lots, escrows, reservations and balances), so
 * this module adds the missing layer: the outermost call opens the real
 * transaction, and every nested call becomes a SAVEPOINT.
 *
 * Consequences that T3/T4/T5 rely on:
 * - a repository method is atomic on its own (it is the outer call);
 * - a repository method called inside `runAtomic`/`withTransaction` joins that
 *   unit of work instead of committing early or throwing;
 * - a failure at any depth still rolls the whole unit back.
 *
 * Savepoint names are static literals (no SQL identifier interpolation) and the
 * depth per connection is tracked in a WeakMap; exceeding the fixed depth is a
 * programming error that fails loudly instead of mis-nesting.
 */

import type { Database } from 'bun:sqlite';

import { withTransaction } from './database.ts';

const MAX_SAVEPOINT_DEPTH = 8;

const SAVEPOINT_OPEN = [
  'SAVEPOINT gf_sp_1',
  'SAVEPOINT gf_sp_2',
  'SAVEPOINT gf_sp_3',
  'SAVEPOINT gf_sp_4',
  'SAVEPOINT gf_sp_5',
  'SAVEPOINT gf_sp_6',
  'SAVEPOINT gf_sp_7',
  'SAVEPOINT gf_sp_8',
] as const;

const SAVEPOINT_RELEASE = [
  'RELEASE gf_sp_1',
  'RELEASE gf_sp_2',
  'RELEASE gf_sp_3',
  'RELEASE gf_sp_4',
  'RELEASE gf_sp_5',
  'RELEASE gf_sp_6',
  'RELEASE gf_sp_7',
  'RELEASE gf_sp_8',
] as const;

const SAVEPOINT_ROLLBACK = [
  'ROLLBACK TO gf_sp_1',
  'ROLLBACK TO gf_sp_2',
  'ROLLBACK TO gf_sp_3',
  'ROLLBACK TO gf_sp_4',
  'ROLLBACK TO gf_sp_5',
  'ROLLBACK TO gf_sp_6',
  'ROLLBACK TO gf_sp_7',
  'ROLLBACK TO gf_sp_8',
] as const;

const depthByDatabase = new WeakMap<Database, number>();

/**
 * Run `work` atomically: the outer call opens a transaction, nested calls use
 * savepoints, and any thrown error unwinds everything this call wrote.
 */
export function runAtomic<T>(database: Database, work: () => T): T {
  if (!database.inTransaction) {
    return withTransaction(database, work);
  }

  const depth = depthByDatabase.get(database) ?? 0;
  if (depth >= MAX_SAVEPOINT_DEPTH) {
    throw new Error(
      `runAtomic exceeded the supported nesting depth (${MAX_SAVEPOINT_DEPTH}); ` +
        'compose fewer units of work or raise the limit explicitly',
    );
  }

  depthByDatabase.set(database, depth + 1);
  database.exec(SAVEPOINT_OPEN[depth]);
  try {
    const result = work();
    database.exec(SAVEPOINT_RELEASE[depth]);
    return result;
  } catch (error) {
    try {
      database.exec(SAVEPOINT_ROLLBACK[depth]);
      database.exec(SAVEPOINT_RELEASE[depth]);
    } catch {
      // A failed savepoint unwind must not mask the original failure; the outer
      // transaction still rolls back everything on its own throw.
    }
    throw error;
  } finally {
    depthByDatabase.set(database, depth);
  }
}
