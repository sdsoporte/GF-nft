/**
 * Migration 7 — "credit_journal": the durable, append-only monetary journal
 * (S4/S14).
 *
 * Why these three tables, and why none of them stores money the engine spends:
 *
 * - `credit_ledger_openings` is the immutable per-match start of the journal:
 *   the tick the balances were observed at, and whether the journal covers the
 *   whole match (COMPLETE) or enters legacy state at a cutover tick (CUTOVER).
 *   One row per match, no update path.
 * - `credit_ledger_opening_balances` records the observed available and held
 *   balances at that tick. `account_json` is the canonical typed account ref, so
 *   the composite primary key rejects a duplicated account per opening. Sinks
 *   are rejected here: sinks accumulate from movements, and an observed opening
 *   must not invent them.
 * - `credit_ledger_movements` is append-only: positive amounts, a per-match
 *   sequence that is the primary key, and a `UNIQUE (match_id, event_key)` guard
 *   so a repeated settlement cannot record the same event twice.
 *
 * `contract_id` is nullable on purpose: maintenance payments belong to no
 * contract. It is therefore absent from every uniqueness rule — the event key,
 * never the nullable contract, is what makes a movement unique.
 *
 * `companies.credits` remains the authoritative spendable balance. This journal
 * is evidence and audit, not a second mutable store of credits, and the upgrade
 * writes nothing into these tables: no back-paid history, no opening guesses.
 */

import type { Migration } from '../migrations.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS credit_ledger_openings (
    match_id TEXT PRIMARY KEY REFERENCES matches(match_id),
    observed_at_tick INTEGER NOT NULL CHECK (observed_at_tick >= 0),
    coverage TEXT NOT NULL CHECK (coverage IN ('COMPLETE', 'CUTOVER')),
    opened_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_ledger_opening_balances (
    match_id TEXT NOT NULL REFERENCES credit_ledger_openings(match_id) ON DELETE CASCADE,
    account_json TEXT NOT NULL,
    balance_credits INTEGER NOT NULL CHECK (balance_credits >= 0),
    PRIMARY KEY (match_id, account_json)
);

CREATE TABLE IF NOT EXISTS credit_ledger_movements (
    match_id TEXT NOT NULL REFERENCES matches(match_id),
    sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
    event_key TEXT NOT NULL CHECK (length(event_key) > 0),
    tick INTEGER NOT NULL CHECK (tick >= 0),
    contract_id TEXT CHECK (contract_id IS NULL OR length(contract_id) > 0),
    kind TEXT NOT NULL CHECK (kind IN (
        'BUYER_ESCROW_DEPOSIT',
        'SELLER_COLLATERAL_DEPOSIT',
        'DELIVERY_PAYMENT',
        'FEE_SINK',
        'INDEMNITY_TRANSFER',
        'REFUND',
        'MAINTENANCE_SINK'
    )),
    amount_credits INTEGER NOT NULL CHECK (amount_credits > 0),
    source_account_json TEXT NOT NULL,
    destination_account_json TEXT NOT NULL,
    recorded_at_utc TEXT NOT NULL,
    PRIMARY KEY (match_id, sequence_number),
    UNIQUE (match_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_credit_movements_contract
    ON credit_ledger_movements(match_id, contract_id);
CREATE INDEX IF NOT EXISTS idx_credit_movements_tick
    ON credit_ledger_movements(match_id, tick);
`;

export const CREDIT_JOURNAL_MIGRATION: Migration = {
  version: 7,
  name: 'credit_journal',
  sql: SQL,
};
