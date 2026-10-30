/**
 * Migration 8 — "mcp_policy_events": durable MCP policy evidence (issue #15).
 *
 * Why this table exists: the gateway enforced rate limits, per-match write
 * quotas and per-line cooldowns from process-local Maps. A backend restart
 * dropped all of it, so a restart or a second instance could evade every
 * limit. This table is the append-only evidence those checks consult.
 *
 * One row per consumed quota event, written by the gateway when an invoke
 * passes authorization and consumes its quota:
 *
 * - `kind = 'read' | 'write'`: rate-limit events. `write` rows also carry the
 *   `match_id`, so the per-match write quota is a count over the same rows.
 * - `kind = 'line_write'`: one row per accepted line action, carrying the
 *   `company_id`, `line_id`, `tool` and the engine `tick` at which it was
 *   accepted. The per-line cooldown is `MAX(tick)` over these rows; the engine
 *   tick (not wall time) is what the cooldown semantics compare against.
 *
 * `grant_id` is a plain TEXT reference, not a foreign key: grants can be
 * revoked and deleted while their historical events must keep counting, and a
 * deleted grant's rows are harmless evidence. `line_id`, `tool` and `tick` are
 * nullable because read/write rate events have no line context.
 *
 * The table stores evidence, not decisions: the checks always consult it at
 * check time, so any instance sharing the database sees the same limits.
 */

import type { Migration } from '../migrations.ts';

const SQL = `
CREATE TABLE IF NOT EXISTS mcp_policy_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    grant_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('read', 'write', 'line_write')),
    at_utc_ms INTEGER NOT NULL CHECK (at_utc_ms >= 0),
    match_id TEXT,
    company_id TEXT,
    line_id TEXT,
    tool TEXT,
    tick INTEGER CHECK (tick IS NULL OR tick >= 0)
);

CREATE INDEX IF NOT EXISTS idx_mcp_policy_events_grant_time
    ON mcp_policy_events (grant_id, kind, at_utc_ms);
CREATE INDEX IF NOT EXISTS idx_mcp_policy_events_line
    ON mcp_policy_events (company_id, line_id, tool, tick);
CREATE INDEX IF NOT EXISTS idx_mcp_policy_events_match
    ON mcp_policy_events (grant_id, match_id, kind);
`;

export const MCP_POLICY_EVENTS_MIGRATION: Migration = {
  version: 8,
  name: 'mcp_policy_events',
  sql: SQL,
};
