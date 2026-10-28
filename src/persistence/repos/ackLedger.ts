/**
 * `match_ack_ledger` repository: the HTTP acknowledgement ledger (S3/S8).
 *
 * One row per unique `requestId` accepted by the match, holding the payload
 * fingerprint and the command id that was returned. A restart replays from it,
 * so the same `requestId` returns the *same* acknowledgement and never creates
 * a second movement (S8): the match checks this ledger before it touches the
 * engine.
 *
 * Capacity is a rejection, not an eviction. `backend/test/limits.test.ts` pins
 * the observable behaviour at 1024 unique requests per match: exact retries
 * keep working, a new `requestId` gets `COMMAND_LIMIT`. Evicting the oldest row
 * to make space would silently lose an acknowledgement and turn a valid retry
 * into a duplicate movement, which is exactly what S6/S8 forbid. The repository
 * therefore refuses the insert when the ledger is full, and reports the reason
 * through `AckLedgerCapacityError`.
 */

import type { Database } from 'bun:sqlite';

import type { AckLedgerRecord, AckLedgerWrite } from './types.ts';
import { runAtomic } from '../transaction.ts';
import { assertNonEmptyString, assertPositiveInteger } from './validate.ts';

const COLUMNS = 'match_id, request_id, fingerprint, command_id, acknowledged_at_utc';

/** Acknowledgement order, which is also the order a restart replays them in. */
const SELECT_ALL_SQL = `SELECT ${COLUMNS} FROM match_ack_ledger
  WHERE match_id = ? ORDER BY rowid ASC`;
const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM match_ack_ledger
  WHERE match_id = ? AND request_id = ?`;
const COUNT_SQL = 'SELECT COUNT(*) AS total FROM match_ack_ledger WHERE match_id = ?';
const INSERT_SQL = `INSERT INTO match_ack_ledger (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`;

interface AckLedgerRow {
  readonly match_id: string;
  readonly request_id: string;
  readonly fingerprint: string;
  readonly command_id: string;
  readonly acknowledged_at_utc: string;
}

function toAckLedgerRecord(row: AckLedgerRow): AckLedgerRecord {
  return {
    matchId: row.match_id,
    requestId: row.request_id,
    fingerprint: row.fingerprint,
    commandId: row.command_id,
    acknowledgedAtUtc: row.acknowledged_at_utc,
  };
}

/** The match already acknowledges `capacity` requests; a new ID cannot fit. */
export class AckLedgerCapacityError extends Error {
  constructor(
    readonly matchId: string,
    readonly capacity: number,
  ) {
    super(
      `The acknowledgement ledger for match "${matchId}" already holds ${capacity} requests; ` +
        'an acknowledgement is never evicted, so a new requestId cannot be admitted',
    );
    this.name = 'AckLedgerCapacityError';
  }
}

export class AckLedgerRepository {
  constructor(private readonly database: Database) {}

  /**
   * Persist one acknowledgement. Throws `AckLedgerCapacityError` when the
   * ledger is already at `capacity` (nothing is evicted), and lets the primary
   * key reject a duplicate `requestId` instead of overwriting it.
   */
  record(input: AckLedgerWrite): void {
    assertNonEmptyString(input.matchId, 'matchId');
    assertNonEmptyString(input.requestId, 'requestId');
    assertNonEmptyString(input.fingerprint, 'fingerprint');
    assertNonEmptyString(input.commandId, 'commandId');
    assertPositiveInteger(input.capacity, 'capacity');

    const acknowledgedAtUtc = input.acknowledgedAtUtc ?? new Date().toISOString();
    runAtomic(this.database, () => {
      if (this.count(input.matchId) >= input.capacity) {
        throw new AckLedgerCapacityError(input.matchId, input.capacity);
      }
      this.database
        .query(INSERT_SQL)
        .run(
          input.matchId,
          input.requestId,
          input.fingerprint,
          input.commandId,
          acknowledgedAtUtc,
        );
    });
  }

  get(matchId: string, requestId: string): AckLedgerRecord | null {
    const row = this.database.query<AckLedgerRow>(SELECT_ONE_SQL).get(matchId, requestId);
    return row ? toAckLedgerRecord(row) : null;
  }

  /** Every acknowledgement for the match, in acknowledgement order. */
  list(matchId: string): AckLedgerRecord[] {
    return this.database
      .query<AckLedgerRow>(SELECT_ALL_SQL)
      .all(matchId)
      .map(toAckLedgerRecord);
  }

  count(matchId: string): number {
    return this.database.query<{ total: number }>(COUNT_SQL).get(matchId)?.total ?? 0;
  }
}
