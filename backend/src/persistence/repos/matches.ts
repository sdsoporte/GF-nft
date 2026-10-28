/**
 * `matches` repository: the per-match metadata a restart restores (S3/S6).
 *
 * What lives here and why: `seed` and `tick_interval_ms` are boot inputs that
 * cannot be re-derived, `current_tick`/`sequence_counter`/`history_cursor` are
 * the monotonic counters a resumed match must not go backwards on, and the
 * command queue / ack ledger rows hang off this table by foreign key.
 *
 * `created_at_utc` is never overwritten on update, so a match keeps the time it
 * was first persisted even though every command and every tick rewrites the
 * row.
 */

import type { Database } from 'bun:sqlite';

import type { MatchMetadataRecord, MatchMetadataWrite } from './types.ts';
import { runAtomic } from '../transaction.ts';
import { assertNonNegativeInteger, assertNonEmptyString } from './validate.ts';

const COLUMNS = `match_id, seed, current_tick, sequence_counter, history_cursor,
  tick_interval_ms, created_at_utc, updated_at_utc`;

const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM matches WHERE match_id = ?`;
/** Most recently touched match, used by boot when no match id is configured. */
const SELECT_LATEST_SQL = `SELECT ${COLUMNS} FROM matches ORDER BY updated_at_utc DESC, rowid DESC LIMIT 1`;

const UPSERT_SQL = `
INSERT INTO matches (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(match_id) DO UPDATE SET
  seed = excluded.seed,
  current_tick = excluded.current_tick,
  sequence_counter = excluded.sequence_counter,
  history_cursor = excluded.history_cursor,
  tick_interval_ms = excluded.tick_interval_ms,
  updated_at_utc = excluded.updated_at_utc`;

interface MatchRow {
  readonly match_id: string;
  readonly seed: number;
  readonly current_tick: number;
  readonly sequence_counter: number;
  readonly history_cursor: number;
  readonly tick_interval_ms: number;
  readonly created_at_utc: string;
  readonly updated_at_utc: string;
}

function toMatchMetadata(row: MatchRow): MatchMetadataRecord {
  return {
    matchId: row.match_id,
    seed: row.seed,
    currentTick: row.current_tick,
    sequenceCounter: row.sequence_counter,
    historyCursor: row.history_cursor,
    tickIntervalMs: row.tick_interval_ms,
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  };
}

/**
 * Write-path validation exists because migration 2 could not attach a CHECK to
 * `tick_interval_ms` through `ALTER TABLE`; the counters keep their schema
 * CHECKs but are re-checked here so a caller sees one error family.
 */
function validate(input: MatchMetadataWrite): void {
  assertNonEmptyString(input.matchId, 'matchId');
  assertNonNegativeInteger(input.seed, 'seed');
  assertNonNegativeInteger(input.currentTick, 'currentTick');
  assertNonNegativeInteger(input.sequenceCounter, 'sequenceCounter');
  assertNonNegativeInteger(input.historyCursor, 'historyCursor');
  assertNonNegativeInteger(input.tickIntervalMs, 'tickIntervalMs');
}

export class MatchMetadataRepository {
  constructor(private readonly database: Database) {}

  load(matchId: string): MatchMetadataRecord | null {
    const row = this.database.query<MatchRow>(SELECT_ONE_SQL).get(matchId);
    return row ? toMatchMetadata(row) : null;
  }

  /** The most recently updated match, or null on a fresh database. */
  loadLatest(): MatchMetadataRecord | null {
    const row = this.database.query<MatchRow>(SELECT_LATEST_SQL).get();
    return row ? toMatchMetadata(row) : null;
  }

  exists(matchId: string): boolean {
    return this.load(matchId) !== null;
  }

  save(input: MatchMetadataWrite): void {
    validate(input);
    const now = new Date().toISOString();
    const createdAtUtc = input.createdAtUtc ?? now;
    const updatedAtUtc = input.updatedAtUtc ?? now;

    runAtomic(this.database, () => {
      this.database
        .query(UPSERT_SQL)
        .run(
          input.matchId,
          input.seed,
          input.currentTick,
          input.sequenceCounter,
          input.historyCursor,
          input.tickIntervalMs,
          createdAtUtc,
          updatedAtUtc,
        );
    });
  }
}
