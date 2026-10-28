-- ==============================================================================
-- GigaForge v4.1 - Production SQLite Schema
-- Reference: WEB3_DOMAIN_MODEL.md, MCP_SECURITY_SPEC.md, VALIDATION_PROTOCOL.md
-- Strict integer arithmetic, indexed foreign keys, immutable audit trails.
-- ==============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. COMPANIES (Industrial Enterprises)
CREATE TABLE IF NOT EXISTS companies (
    company_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    industrial_class TEXT NOT NULL CHECK(industrial_class IN ('CLASS_A_METALLURGY', 'CLASS_B_MANUFACTURING')),
    is_npc INTEGER NOT NULL DEFAULT 0 CHECK(is_npc IN (0, 1)),
    credits INTEGER NOT NULL DEFAULT 10000 CHECK(credits >= 0),
    energy INTEGER NOT NULL DEFAULT 400 CHECK(energy >= 0),
    max_energy_storage INTEGER NOT NULL DEFAULT 1000 CHECK(max_energy_storage > 0),
    energy_generation_per_tick INTEGER NOT NULL DEFAULT 20 CHECK(energy_generation_per_tick >= 0),
    installed_turbines_r7 INTEGER NOT NULL DEFAULT 0 CHECK(installed_turbines_r7 >= 0),
    contributed_megamachine_parts_r8 INTEGER NOT NULL DEFAULT 0 CHECK(contributed_megamachine_parts_r8 >= 0),
    reputation INTEGER NOT NULL DEFAULT 100 CHECK(reputation >= 0),
    created_at_utc TEXT NOT NULL,
    updated_at_utc TEXT NOT NULL
);

-- 2. INVENTORIES (Per-Item Balances & Reservations)
-- Enforces Invariant 1: available_qty and reserved_qty are strictly non-negative integers.
CREATE TABLE IF NOT EXISTS inventories (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    item_id TEXT NOT NULL CHECK(item_id IN (
        'RAW_ORE', 'IRON_INGOT', 'STEEL_PLATE', 'HEAVY_ALLOY',
        'MECH_FRAME', 'CTRL_CIRCUIT', 'POWER_MODULE', 'IND_TURBINE', 'MEGAMACHINE_PART'
    )),
    available_qty INTEGER NOT NULL DEFAULT 0 CHECK(available_qty >= 0),
    reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK(reserved_qty >= 0),
    updated_at_tick INTEGER NOT NULL DEFAULT 0,
    UNIQUE(company_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_inventories_company ON inventories(company_id);

-- 3. PRODUCTION LINES
CREATE TABLE IF NOT EXISTS production_lines (
    line_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 2 CHECK(priority IN (1, 2, 3)),
    status TEXT NOT NULL DEFAULT 'IDLE' CHECK(status IN ('IDLE', 'RUNNING', 'PAUSED', 'NO_ENERGY')),
    current_recipe_id TEXT CHECK(current_recipe_id IS NULL OR current_recipe_id IN ('R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8')),
    total_batches_produced INTEGER NOT NULL DEFAULT 0 CHECK(total_batches_produced >= 0),
    last_action_tick INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_production_lines_company ON production_lines(company_id);

-- 4. B2B SUPPLY CONTRACTS
CREATE TABLE IF NOT EXISTS b2b_contracts (
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
    status TEXT NOT NULL CHECK(status IN ('PENDING', 'ACTIVE', 'FULFILLED', 'DEFAULTED', 'CANCELLED')),
    settled_at_tick INTEGER
);

CREATE INDEX IF NOT EXISTS idx_contracts_seller ON b2b_contracts(seller_company_id);
CREATE INDEX IF NOT EXISTS idx_contracts_buyer ON b2b_contracts(buyer_company_id);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON b2b_contracts(status);

-- 5. INVENTORY RESERVATIONS & COMMODITY LOTS (Pre-Web3 Packaging)
CREATE TABLE IF NOT EXISTS inventory_reservations (
    reservation_id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(company_id),
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    lot_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'UNPACKED', 'REVERTED')),
    created_at_tick INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commodity_lots (
    lot_id TEXT PRIMARY KEY,
    origin_company_id TEXT NOT NULL REFERENCES companies(company_id),
    current_holder_company_id TEXT NOT NULL REFERENCES companies(company_id),
    item_id TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    reservation_id TEXT NOT NULL REFERENCES inventory_reservations(reservation_id),
    status TEXT NOT NULL CHECK(status IN (
        'RESERVED_OFF_CHAIN',
        'TOKENIZED_RECEIPT',
        'IN_ESCROW',
        'SETTLED_PENDING_CLAIM',
        'CONSUMED_UNPACKED',
        'CANCELLED_RESTORED'
    )),
    state_hash TEXT NOT NULL,
    created_at_tick INTEGER NOT NULL,
    settled_at_tick INTEGER
);

CREATE INDEX IF NOT EXISTS idx_commodity_lots_holder ON commodity_lots(current_holder_company_id);
CREATE INDEX IF NOT EXISTS idx_commodity_lots_status ON commodity_lots(status);

-- 6. TRADE ESCROW (Atomic Delivery & Collateral Lock)
CREATE TABLE IF NOT EXISTS trade_escrows (
    escrow_id TEXT PRIMARY KEY,
    lot_id TEXT NOT NULL REFERENCES commodity_lots(lot_id),
    seller_company_id TEXT NOT NULL REFERENCES companies(company_id),
    buyer_company_id TEXT NOT NULL REFERENCES companies(company_id),
    agreed_price_amount INTEGER NOT NULL CHECK(agreed_price_amount > 0),
    currency_type TEXT NOT NULL CHECK(currency_type IN ('INTERNAL_CREDITS', 'TESTNET_TOKEN', 'STABLECOIN')),
    seller_collateral_amount INTEGER NOT NULL CHECK(seller_collateral_amount >= 0),
    deadline_tick INTEGER NOT NULL,
    settlement_state TEXT NOT NULL CHECK(settlement_state IN (
        'AWAITING_DEPOSITS', 'LOCKED', 'RELEASED_TO_BUYER', 'REFUNDED', 'DISPUTED'
    )),
    external_tx_hash TEXT,
    settled_at_tick INTEGER
);

CREATE INDEX IF NOT EXISTS idx_trade_escrows_lot ON trade_escrows(lot_id);

-- 7. USAGE RIGHTS (ERC-4907 Off-Chain Deterministic Leasing)
-- Enforces Invariant 2: Decoupled ownership from facility/blueprint usage
CREATE TABLE IF NOT EXISTS usage_rights (
    usage_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    beneficiary_company_id TEXT NOT NULL REFERENCES companies(company_id),
    valid_from_tick INTEGER NOT NULL,
    expires_at_tick INTEGER NOT NULL CHECK(expires_at_tick > valid_from_tick),
    revenue_share_bps INTEGER NOT NULL DEFAULT 0 CHECK(revenue_share_bps BETWEEN 0 AND 10000),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_usage_rights_beneficiary ON usage_rights(beneficiary_company_id);

-- 8. MCP GRANTS & SECURITY AUDIT LOGS
CREATE TABLE IF NOT EXISTS mcp_grants (
    grant_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    player_id TEXT NOT NULL,
    company_id TEXT NOT NULL REFERENCES companies(company_id),
    match_id TEXT NOT NULL,
    phase_mode TEXT NOT NULL CHECK(phase_mode IN ('PHASE_1_READ_ONLY', 'PHASE_1B_READ_WRITE')),
    scopes_json TEXT NOT NULL,
    resource_allowlist_json TEXT NOT NULL,
    max_read_per_minute INTEGER NOT NULL DEFAULT 60,
    max_write_per_minute INTEGER NOT NULL DEFAULT 12,
    max_write_per_match INTEGER NOT NULL DEFAULT 500,
    created_at_utc TEXT NOT NULL,
    expires_at_utc TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
);

CREATE TABLE IF NOT EXISTS mcp_audit_logs (
    id TEXT PRIMARY KEY,
    timestamp_utc TEXT NOT NULL,
    tick INTEGER NOT NULL,
    grant_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    idempotency_key TEXT,
    result_code TEXT NOT NULL,
    execution_time_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_audit_grant ON mcp_audit_logs(grant_id);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_tick ON mcp_audit_logs(tick);

-- 9. MATCH TELEMETRY (A/B/C Test Suite Logs)
CREATE TABLE IF NOT EXISTS match_telemetry (
    telemetry_id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL,
    tick INTEGER NOT NULL,
    voluntary_contracts_signed INTEGER NOT NULL DEFAULT 0,
    quote_comparisons_count INTEGER NOT NULL DEFAULT 0,
    make_vs_buy_ratio INTEGER NOT NULL DEFAULT 0,
    contract_default_rate INTEGER NOT NULL DEFAULT 0,
    mcp_commands_accepted INTEGER NOT NULL DEFAULT 0,
    mcp_commands_rejected INTEGER NOT NULL DEFAULT 0,
    global_r8_delivered INTEGER NOT NULL DEFAULT 0
);
