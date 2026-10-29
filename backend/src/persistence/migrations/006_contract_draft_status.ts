/**
 * Migration 6 — admit non-binding DRAFT contracts without changing legacy rows.
 * SQLite cannot widen an existing CHECK in place. The migration runner wraps
 * this table replacement and its bookkeeping row in one transaction; any
 * failure restores the original table, rows and indexes. No FK targets this
 * table in the supported schema. Baseline schema.sql/migration 1 stay intact.
 */
import type { Migration } from '../migrations.ts';

const SQL = `
CREATE TABLE b2b_contracts_v6 (
    contract_id TEXT PRIMARY KEY,
    seller_company_id TEXT NOT NULL REFERENCES companies(company_id),
    buyer_company_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    total_quantity INTEGER NOT NULL CHECK(total_quantity > 0),
    delivered_quantity INTEGER NOT NULL DEFAULT 0 CHECK(delivered_quantity >= 0),
    unit_price_credits INTEGER NOT NULL CHECK(unit_price_credits > 0),
    total_value_credits INTEGER NOT NULL CHECK(total_value_credits > 0),
    collateral_seller_credits INTEGER NOT NULL CHECK(collateral_seller_credits >= 0),
    created_at_tick INTEGER NOT NULL,
    deadline_tick INTEGER NOT NULL CHECK(deadline_tick > created_at_tick),
    penalty_per_missing_unit INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL CHECK(status IN ('DRAFT', 'PENDING', 'ACTIVE', 'FULFILLED', 'DEFAULTED', 'CANCELLED')),
    settled_at_tick INTEGER
);
INSERT INTO b2b_contracts_v6 (
    contract_id, seller_company_id, buyer_company_id, item_id, total_quantity,
    delivered_quantity, unit_price_credits, total_value_credits, collateral_seller_credits,
    created_at_tick, deadline_tick, penalty_per_missing_unit, status, settled_at_tick
)
SELECT contract_id, seller_company_id, buyer_company_id, item_id, total_quantity,
    delivered_quantity, unit_price_credits, total_value_credits, collateral_seller_credits,
    created_at_tick, deadline_tick, penalty_per_missing_unit, status, settled_at_tick
FROM b2b_contracts;
DROP TABLE b2b_contracts;
ALTER TABLE b2b_contracts_v6 RENAME TO b2b_contracts;
CREATE INDEX idx_contracts_seller ON b2b_contracts(seller_company_id);
CREATE INDEX idx_contracts_buyer ON b2b_contracts(buyer_company_id);
CREATE INDEX idx_contracts_status ON b2b_contracts(status);
`;

export const CONTRACT_DRAFT_STATUS_MIGRATION: Migration = {
  version: 6,
  name: 'contract_draft_status',
  sql: SQL,
};
