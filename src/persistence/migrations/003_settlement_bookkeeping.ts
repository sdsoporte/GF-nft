/**
 * Migration 3 — "settlement_bookkeeping": the two small tables the local
 * settlement provider needs to replace its former in-process counters.
 *
 * T5a found the provider relied on three `Map`s and one `Map` of nonces, which
 * meant a restart lost (a) the id sequence and (b) the EIP-712 anti-replay
 * counters. Both are bookkeeping, not ledger state, so they get their own tables
 * instead of being smuggled into `commodity_lots`/`trade_escrows` columns:
 *
 * - `settlement_counters` is a durable named sequence. `SqliteLocalSettlementProvider`
 *   allocates lot/reservation/escrow ids from it, so a restarted process can
 *   never reissue an id an earlier process already used.
 * - `account_nonces` is the per-account anti-replay counter. Keeping it in
 *   memory would reopen a replay window after every restart, which is exactly the
 *   property the nonce exists to deny.
 *
 * Values are strictly positive on both tables: a sequence row is created with 1
 * on first use, and a nonce is never handed out as 0.
 */

import type { Migration } from '../migrations.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS settlement_counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL CHECK (value > 0)
);

CREATE TABLE IF NOT EXISTS account_nonces (
    company_id TEXT PRIMARY KEY REFERENCES companies(company_id),
    nonce INTEGER NOT NULL CHECK (nonce > 0)
);
`;

export const SETTLEMENT_BOOKKEEPING_MIGRATION: Migration = {
  version: 3,
  name: 'settlement_bookkeeping',
  sql: SQL,
};
