/**
 * Migration 008: Durable Replay Snapshots (issue #11).
 *
 * Persists periodic simulation checkpoints and canonical state JSON with
 * cryptographic SHA-256 checksums to enable exact match replay and recovery.
 */

import type { Migration } from '../migrations.ts';

export const REPLAY_SNAPSHOTS_MIGRATION: Migration = {
  version: 8,
  name: '008_replay_snapshots',
  sql: `CREATE TABLE IF NOT EXISTS match_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    tick INTEGER NOT NULL CHECK(tick >= 0),
    checksum_sha256 TEXT NOT NULL,
    state_hash TEXT NOT NULL,
    state_json TEXT NOT NULL,
    created_at_utc TEXT NOT NULL,
    UNIQUE(match_id, tick)
);

CREATE INDEX IF NOT EXISTS idx_match_snapshots_match_tick ON match_snapshots(match_id, tick);`,
};
