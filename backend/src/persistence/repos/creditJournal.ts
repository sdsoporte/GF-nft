/**
 * `credit_ledger_openings` / `credit_ledger_opening_balances` /
 * `credit_ledger_movements`: the append-only monetary journal (S4/S14).
 *
 * Scope of this repository: storage and audit only. It records an immutable
 * opening and append-only movements; it does **not** debit, credit, price a
 * delivery or change a fee. `companies.credits` remains the authoritative
 * spendable balance, and a settlement (T4) will compose this repository inside
 * its own `runAtomic` unit of work so the money change and its evidence commit
 * together.
 *
 * Guarantees:
 *
 * - the opening is written once per match and never updated, so an observed
 *   legacy balance cannot be rewritten later;
 * - movements are append-only: the per-match `sequence_number` is the primary
 *   key and `event_key` is unique per match, so a retried settlement cannot
 *   record the same economic event twice. `contract_id` is nullable and is
 *   never part of a uniqueness rule because maintenance has no contract;
 * - a batch is all-or-nothing. Validation and the duplicate/sequence checks run
 *   inside the write loop, so a rejection at movement N removes movements 1..N-1
 *   (and, when called from `MatchStore.commitExecutions`, the tick metadata and
 *   execution history written before it);
 * - tick provenance is checked against the persisted match: a movement can
 *   never be dated after the match's current tick or before the journal opening.
 *
 * Every account reference is stored as its canonical JSON encoding and decoded
 * strictly on the way out, so a corrupt payload fails loudly instead of
 * silently becoming another account.
 */

import type { Database } from 'bun:sqlite';

import {
  CreditLedgerValidationError,
  encodeCreditAccountRef,
  decodeCreditAccountRef,
  validateCreditLedgerOpening,
  validateCreditMovement,
  type CreditCoverage,
  type CreditLedgerBalance,
  type CreditLedgerMovement,
} from '../../domain/creditLedger.ts';
import { runAtomic } from '../transaction.ts';
import type {
  CreditJournalMovementRecord,
  CreditJournalMovementWrite,
  CreditJournalOpeningRecord,
  CreditJournalOpeningWrite,
} from './types.ts';

/** Rejections the journal adds on top of domain validation. */
export type CreditJournalErrorCode =
  | 'MATCH_UNKNOWN'
  | 'MATCH_MISMATCH'
  | 'OPENING_MISSING'
  | 'OPENING_EXISTS'
  | 'FUTURE_TICK'
  | 'TICK_BEFORE_OPENING'
  | 'SEQUENCE_OUT_OF_ORDER'
  | 'DUPLICATE_EVENT_KEY';

/** Rejected persistence input. `message` is always `"<CODE>: <detail>"`. */
export class CreditJournalError extends Error {
  constructor(
    readonly code: CreditJournalErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'CreditJournalError';
  }
}

const OPENING_COLUMNS = 'match_id, observed_at_tick, coverage, opened_at_utc';
const BALANCE_COLUMNS = 'match_id, account_json, balance_credits';
const MOVEMENT_COLUMNS = `match_id, sequence_number, event_key, tick, contract_id, kind,
  amount_credits, source_account_json, destination_account_json, recorded_at_utc`;

const SELECT_OPENING_SQL = `SELECT ${OPENING_COLUMNS} FROM credit_ledger_openings WHERE match_id = ?`;
const SELECT_BALANCES_SQL = `SELECT ${BALANCE_COLUMNS} FROM credit_ledger_opening_balances
  WHERE match_id = ? ORDER BY account_json ASC`;
const INSERT_OPENING_SQL = `INSERT INTO credit_ledger_openings (${OPENING_COLUMNS}) VALUES (?, ?, ?, ?)`;
const INSERT_BALANCE_SQL = `INSERT INTO credit_ledger_opening_balances (${BALANCE_COLUMNS}) VALUES (?, ?, ?)`;

const SELECT_MOVEMENTS_SQL = `SELECT ${MOVEMENT_COLUMNS} FROM credit_ledger_movements
  WHERE match_id = ? ORDER BY sequence_number ASC`;
const COUNT_MOVEMENTS_SQL = 'SELECT COUNT(*) AS total FROM credit_ledger_movements WHERE match_id = ?';
const MAX_SEQUENCE_SQL = `SELECT COALESCE(MAX(sequence_number), 0) AS max_sequence
  FROM credit_ledger_movements WHERE match_id = ?`;
const EVENT_KEY_SQL = `SELECT 1 AS found FROM credit_ledger_movements
  WHERE match_id = ? AND event_key = ?`;
const INSERT_MOVEMENT_SQL = `INSERT INTO credit_ledger_movements (${MOVEMENT_COLUMNS})
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const MATCH_TICK_SQL = 'SELECT current_tick FROM matches WHERE match_id = ?';

interface OpeningRow {
  readonly match_id: string;
  readonly observed_at_tick: number;
  readonly coverage: string;
  readonly opened_at_utc: string;
}

interface BalanceRow {
  readonly account_json: string;
  readonly balance_credits: number;
}

interface MovementRow {
  readonly match_id: string;
  readonly sequence_number: number;
  readonly event_key: string;
  readonly tick: number;
  readonly contract_id: string | null;
  readonly kind: string;
  readonly amount_credits: number;
  readonly source_account_json: string;
  readonly destination_account_json: string;
  readonly recorded_at_utc: string;
}

function nowUtc(): string {
  return new Date().toISOString();
}

export class CreditJournalRepository {
  constructor(private readonly database: Database) {}

  /**
   * Persist the immutable opening of one match, with its observed balances.
   * Rejects a second opening for the same match: an opening is evidence of what
   * was observed, never a value to refresh.
   */
  createOpening(input: CreditJournalOpeningWrite): CreditJournalOpeningRecord {
    const opening = validateCreditLedgerOpening(input);
    const openedAtUtc = input.openedAtUtc ?? nowUtc();

    runAtomic(this.database, () => {
      const currentTick = this.matchCurrentTick(opening.matchId);
      if (opening.observedAtTick > currentTick) {
        throw new CreditJournalError(
          'FUTURE_TICK',
          `opening for match "${opening.matchId}" observes tick ${opening.observedAtTick} ` +
            `but the match is at tick ${currentTick}`,
        );
      }
      if (this.selectOpeningRow(opening.matchId)) {
        throw new CreditJournalError(
          'OPENING_EXISTS',
          `match "${opening.matchId}" already has an immutable journal opening`,
        );
      }
      this.database
        .query(INSERT_OPENING_SQL)
        .run(opening.matchId, opening.observedAtTick, opening.coverage, openedAtUtc);
      const statement = this.database.query(INSERT_BALANCE_SQL);
      for (const balance of opening.balances) {
        statement.run(opening.matchId, encodeCreditAccountRef(balance.account), balance.balanceCredits);
      }
    });

    const stored = this.getOpening(opening.matchId);
    if (!stored) {
      throw new Error(`credit journal failed to read back the opening of "${opening.matchId}"`);
    }
    return stored;
  }

  /** The immutable opening of one match, or null when the journal has none. */
  getOpening(matchId: string): CreditJournalOpeningRecord | null {
    const row = this.selectOpeningRow(matchId);
    if (!row) return null;
    const balances: CreditLedgerBalance[] = this.database
      .query<BalanceRow>(SELECT_BALANCES_SQL)
      .all(matchId)
      .map((balance) => ({
        account: decodeCreditAccountRef(balance.account_json) as CreditLedgerBalance['account'],
        balanceCredits: balance.balance_credits,
      }));
    const normalized = validateCreditLedgerOpening({
      matchId: row.match_id,
      observedAtTick: row.observed_at_tick,
      coverage: row.coverage as CreditCoverage,
      balances,
    });
    return { ...normalized, openedAtUtc: row.opened_at_utc };
  }

  count(matchId: string): number {
    return this.database.query<{ total: number }>(COUNT_MOVEMENTS_SQL).get(matchId)?.total ?? 0;
  }


  private selectOpeningRow(matchId: string): OpeningRow | null {
    return this.database.query<OpeningRow>(SELECT_OPENING_SQL).get(matchId) ?? null;
  }

  /** Current tick of a persisted match; unknown matches are a loud rejection. */
  private matchCurrentTick(matchId: string): number {
    const row = this.database.query<{ current_tick: number }>(MATCH_TICK_SQL).get(matchId);
    if (!row) {
      throw new CreditJournalError(
        'MATCH_UNKNOWN',
        `match "${matchId}" is not persisted; the journal cannot be attached to it`,
      );
    }
    return row.current_tick;
  }

}

/** True when the rejection came from the journal layer (not domain validation). */
export function isCreditJournalError(error: unknown): error is CreditJournalError {
  return error instanceof CreditJournalError;
}

/** True when the rejection came from the SQL-free domain validators. */
export function isCreditLedgerValidationError(
  error: unknown,
): error is CreditLedgerValidationError {
  return error instanceof CreditLedgerValidationError;
}
