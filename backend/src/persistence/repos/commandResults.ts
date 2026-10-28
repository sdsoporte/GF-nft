/**
 * `match_command_results` repository: the append-only execution history (S3/S6).
 *
 * Every command the engine executed or rejected gets one row, keyed by its
 * position in the engine's execution history (`history_index`). Together with
 * the queue rows this reconstructs the match command-status map without a
 * separate status table: pending rows are `queued`, rows here are `executed` or
 * `rejected` with the tick and the engine error code.
 *
 * `history_index` is the primary key component, so a double fold of the same
 * result fails loudly instead of duplicating a movement (S8).
 */

import type { Database } from 'bun:sqlite';

import type { CommandResultRecord, CommandResultWrite } from './types.ts';
import { runAtomic } from '../transaction.ts';
import { assertNonNegativeInteger, assertNonEmptyString } from './validate.ts';

const COLUMNS = `match_id, history_index, command_id, idempotency_key, executed_at_tick,
  success, error_code, error_message, company_id`;

const SELECT_ALL_SQL = `SELECT ${COLUMNS} FROM match_command_results
  WHERE match_id = ? ORDER BY history_index ASC`;
const COUNT_SQL = 'SELECT COUNT(*) AS total FROM match_command_results WHERE match_id = ?';
const INSERT_SQL = `INSERT INTO match_command_results (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

interface CommandResultRow {
  readonly match_id: string;
  readonly history_index: number;
  readonly command_id: string;
  readonly idempotency_key: string;
  readonly executed_at_tick: number;
  readonly success: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly company_id: string | null;
}

/**
 * Optional failure fields are omitted (not set to `undefined`) when the column
 * is NULL, so a write -> read round trip is a deep equal.
 */
function toCommandResult(row: CommandResultRow): CommandResultRecord {
  return {
    matchId: row.match_id,
    historyIndex: row.history_index,
    commandId: row.command_id,
    idempotencyKey: row.idempotency_key,
    executedAtTick: row.executed_at_tick,
    success: row.success === 1,
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.company_id === null ? {} : { companyId: row.company_id }),
  };
}

export class CommandResultRepository {
  constructor(private readonly database: Database) {}

  /** Append the results of one tick as a single unit of work. */
  appendMany(inputs: readonly CommandResultWrite[]): void {
    if (inputs.length === 0) return;
    for (const input of inputs) {
      assertNonEmptyString(input.matchId, 'matchId');
      assertNonEmptyString(input.commandId, 'commandId');
      assertNonEmptyString(input.idempotencyKey, 'idempotencyKey');
      if (input.companyId !== undefined) assertNonEmptyString(input.companyId, 'companyId');
      assertNonNegativeInteger(input.historyIndex, 'historyIndex');
      assertNonNegativeInteger(input.executedAtTick, 'executedAtTick');
    }

    const statement = this.database.query(INSERT_SQL);
    runAtomic(this.database, () => {
      for (const input of inputs) {
        statement.run(
          input.matchId,
          input.historyIndex,
          input.commandId,
          input.idempotencyKey,
          input.executedAtTick,
          input.success ? 1 : 0,
          input.errorCode ?? null,
          input.errorMessage ?? null,
          input.companyId ?? null,
        );
      }
    });
  }

  /** Engine history order, which is what a restore folds back in. */
  list(matchId: string): CommandResultRecord[] {
    return this.database
      .query<CommandResultRow>(SELECT_ALL_SQL)
      .all(matchId)
      .map(toCommandResult);
  }

  count(matchId: string): number {
    return this.database.query<{ total: number }>(COUNT_SQL).get(matchId)?.total ?? 0;
  }
}
