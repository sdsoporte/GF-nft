/**
 * `match_command_queue` + `match_processed_idempotency_keys` repositories (S3/S8).
 *
 * Two tables, one responsibility each:
 * - the queue mirrors commands the engine accepted and has not executed yet, so
 *   a restart can see "still pending" instead of silently losing the command;
 * - the processed-key table is the permanent dedupe record. It deliberately
 *   outlives the queue row: once a command executes its queue row is cleared,
 *   and the key is what still proves the command was seen (S8).
 *
 * `UNIQUE(match_id, idempotency_key)` and `UNIQUE(match_id, sequence_number)`
 * are enforced by the schema and surface here as SQLite constraint errors: a
 * duplicate command must fail loudly rather than overwrite a row.
 *
 * Rows are read in place (the columns are already the record shape), so this
 * file has no row-to-domain mapper.
 */

import type { Database } from 'bun:sqlite';

import type {
  ProcessedIdempotencyRecord,
  ProcessedIdempotencyWrite,
  QueuedCommandRecord,
  QueuedCommandWrite,
} from './types.ts';
import { runAtomic } from '../transaction.ts';
import { assertNonEmptyString, assertPositiveInteger } from './validate.ts';

const QUEUE_COLUMNS = `command_id, match_id, company_id, sequence_number, scheduled_tick,
  idempotency_key, command_type, payload_json, created_at_utc`;

/** Arrival order on restore: due commands first, then sequence number. */
const SELECT_PENDING_SQL = `SELECT ${QUEUE_COLUMNS} FROM match_command_queue
  WHERE match_id = ? ORDER BY scheduled_tick ASC, sequence_number ASC`;
const COUNT_PENDING_SQL =
  'SELECT COUNT(*) AS total FROM match_command_queue WHERE match_id = ?';
const DELETE_PENDING_SQL =
  'DELETE FROM match_command_queue WHERE match_id = ? AND command_id = ?';

const INSERT_QUEUE_SQL = `INSERT INTO match_command_queue (${QUEUE_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const PROCESSED_COLUMNS = 'match_id, idempotency_key, command_id, processed_at_utc';
const INSERT_PROCESSED_SQL = `INSERT INTO match_processed_idempotency_keys (${PROCESSED_COLUMNS})
  VALUES (?, ?, ?, ?)`;
const SELECT_PROCESSED_SQL = `SELECT ${PROCESSED_COLUMNS}
  FROM match_processed_idempotency_keys WHERE match_id = ? ORDER BY rowid ASC`;
const SELECT_PROCESSED_ONE_SQL = `SELECT ${PROCESSED_COLUMNS}
  FROM match_processed_idempotency_keys WHERE match_id = ? AND idempotency_key = ?`;
const COUNT_PROCESSED_SQL =
  'SELECT COUNT(*) AS total FROM match_processed_idempotency_keys WHERE match_id = ?';

interface QueuedCommandRow {
  readonly command_id: string;
  readonly match_id: string;
  readonly company_id: string;
  readonly sequence_number: number;
  readonly scheduled_tick: number;
  readonly idempotency_key: string;
  readonly command_type: string;
  readonly payload_json: string;
  readonly created_at_utc: string;
}

interface ProcessedIdempotencyRow {
  readonly match_id: string;
  readonly idempotency_key: string;
  readonly command_id: string;
  readonly processed_at_utc: string;
}

function toQueuedCommand(row: QueuedCommandRow): QueuedCommandRecord {
  return {
    commandId: row.command_id,
    matchId: row.match_id,
    companyId: row.company_id,
    sequenceNumber: row.sequence_number,
    scheduledTick: row.scheduled_tick,
    idempotencyKey: row.idempotency_key,
    commandType: row.command_type,
    payloadJson: row.payload_json,
    createdAtUtc: row.created_at_utc,
  };
}

function toProcessedKey(row: ProcessedIdempotencyRow): ProcessedIdempotencyRecord {
  return {
    matchId: row.match_id,
    idempotencyKey: row.idempotency_key,
    commandId: row.command_id,
    processedAtUtc: row.processed_at_utc,
  };
}

export class CommandQueueRepository {
  constructor(private readonly database: Database) {}

  /** Mirror one accepted command; a duplicate key or sequence throws. */
  enqueue(input: QueuedCommandWrite): void {
    assertNonEmptyString(input.commandId, 'commandId');
    assertNonEmptyString(input.matchId, 'matchId');
    assertNonEmptyString(input.companyId, 'companyId');
    assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
    assertNonEmptyString(input.commandType, 'commandType');
    assertPositiveInteger(input.sequenceNumber, 'sequenceNumber');
    assertNonEmptyString(input.payloadJson, 'payloadJson');

    const createdAtUtc = input.createdAtUtc ?? new Date().toISOString();
    runAtomic(this.database, () => {
      this.database
        .query(INSERT_QUEUE_SQL)
        .run(
          input.commandId,
          input.matchId,
          input.companyId,
          input.sequenceNumber,
          input.scheduledTick,
          input.idempotencyKey,
          input.commandType,
          input.payloadJson,
          createdAtUtc,
        );
    });
  }

  listPending(matchId: string): QueuedCommandRecord[] {
    return this.database
      .query<QueuedCommandRow>(SELECT_PENDING_SQL)
      .all(matchId)
      .map(toQueuedCommand);
  }

  countPending(matchId: string): number {
    return this.database.query<{ total: number }>(COUNT_PENDING_SQL).get(matchId)?.total ?? 0;
  }

  /** Clear the queue rows of commands that reached the execution history. */
  remove(matchId: string, commandIds: readonly string[]): number {
    if (commandIds.length === 0) return 0;
    const statement = this.database.query(DELETE_PENDING_SQL);
    let removed = 0;
    runAtomic(this.database, () => {
      for (const commandId of commandIds) {
        removed += Number(statement.run(matchId, commandId).changes ?? 0);
      }
    });
    return removed;
  }

  /**
   * Record the permanent dedupe key for a command. Called in the same unit of
   * work as `enqueue`, so the key can never exist without its queue row.
   */
  markProcessed(input: ProcessedIdempotencyWrite): void {
    assertNonEmptyString(input.matchId, 'matchId');
    assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
    assertNonEmptyString(input.commandId, 'commandId');

    const processedAtUtc = input.processedAtUtc ?? new Date().toISOString();
    runAtomic(this.database, () => {
      this.database
        .query(INSERT_PROCESSED_SQL)
        .run(input.matchId, input.idempotencyKey, input.commandId, processedAtUtc);
    });
  }

  isProcessed(matchId: string, idempotencyKey: string): boolean {
    return (
      this.database
        .query<ProcessedIdempotencyRow>(SELECT_PROCESSED_ONE_SQL)
        .get(matchId, idempotencyKey) !== null
    );
  }

  listProcessed(matchId: string): ProcessedIdempotencyRecord[] {
    return this.database
      .query<ProcessedIdempotencyRow>(SELECT_PROCESSED_SQL)
      .all(matchId)
      .map(toProcessedKey);
  }

  countProcessed(matchId: string): number {
    return this.database.query<{ total: number }>(COUNT_PROCESSED_SQL).get(matchId)?.total ?? 0;
  }
}
