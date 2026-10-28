/**
 * `settlement_counters` / `account_nonces` repository (migration 3).
 *
 * The local settlement provider needs two kinds of durable bookkeeping that are
 * not ledger rows:
 *
 * - a named **sequence** for lot/reservation/escrow ids, so a restarted process
 *   cannot reissue an id that already exists (an in-memory counter would restart
 *   at 1 and the database's PRIMARY KEY would reject the next write);
 * - a per-account **nonce** for EIP-712 anti-replay, which must never repeat even
 *   across restarts.
 *
 * `next`/`nextAccountNonce` are atomic increments (`ON CONFLICT ... DO UPDATE`)
 * that return the new value, so they compose inside a `runAtomic` unit of work
 * and roll back with it.
 */

import type { Database } from 'bun:sqlite';

import { runAtomic } from '../transaction.ts';
import { assertNonEmptyString } from './validate.ts';

/** The id sequences the provider allocates from; whitelisted, never free-form. */
export type SettlementSequence = 'lot' | 'reservation' | 'escrow';

export const SETTLEMENT_SEQUENCES: readonly SettlementSequence[] = [
  'lot',
  'reservation',
  'escrow',
];

const SELECT_SEQUENCE_SQL = 'SELECT value FROM settlement_counters WHERE name = ?';
const BUMP_SEQUENCE_SQL = `
INSERT INTO settlement_counters (name, value) VALUES (?, 1)
ON CONFLICT(name) DO UPDATE SET value = value + 1`;

const SELECT_NONCE_SQL = 'SELECT nonce FROM account_nonces WHERE company_id = ?';
const BUMP_NONCE_SQL = `
INSERT INTO account_nonces (company_id, nonce) VALUES (?, 1)
ON CONFLICT(company_id) DO UPDATE SET nonce = nonce + 1`;

interface SequenceRow {
  readonly value: number;
}

interface NonceRow {
  readonly nonce: number;
}

function assertKnownSequence(sequence: SettlementSequence): void {
  if (!SETTLEMENT_SEQUENCES.includes(sequence)) {
    throw new Error(
      `Unknown settlement sequence "${String(sequence)}"; expected one of ` +
        SETTLEMENT_SEQUENCES.join(', '),
    );
  }
}

export class SettlementCounterRepository {
  constructor(private readonly database: Database) {}

  /** Atomically take the next value of a named sequence (1-based). */
  next(sequence: SettlementSequence): number {
    assertKnownSequence(sequence);
    return runAtomic(this.database, () => {
      this.database.query(BUMP_SEQUENCE_SQL).run(sequence);
      const row = this.database.query<SequenceRow>(SELECT_SEQUENCE_SQL).get(sequence);
      if (!row) {
        throw new Error(`Settlement sequence "${sequence}" vanished after incrementing`);
      }
      return row.value;
    });
  }

  /** Current value of a sequence, or 0 when it was never used. */
  current(sequence: SettlementSequence): number {
    assertKnownSequence(sequence);
    const row = this.database.query<SequenceRow>(SELECT_SEQUENCE_SQL).get(sequence);
    return row?.value ?? 0;
  }

  /** Atomically take the next anti-replay nonce for `companyId` (1-based). */
  nextAccountNonce(companyId: string): number {
    assertNonEmptyString(companyId, 'companyId');
    return runAtomic(this.database, () => {
      this.database.query(BUMP_NONCE_SQL).run(companyId);
      const row = this.database.query<NonceRow>(SELECT_NONCE_SQL).get(companyId);
      if (!row) {
        throw new Error(`Account nonce for "${companyId}" vanished after incrementing`);
      }
      return row.nonce;
    });
  }

  /** Last nonce handed out for `companyId`, or 0 when it has none. */
  currentAccountNonce(companyId: string): number {
    const row = this.database.query<NonceRow>(SELECT_NONCE_SQL).get(companyId);
    return row?.nonce ?? 0;
  }
}
