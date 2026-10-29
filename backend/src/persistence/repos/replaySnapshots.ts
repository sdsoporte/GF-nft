/**
 * Repository for durable match replay snapshots (issue #11).
 */

import type { Database } from 'bun:sqlite';
import { REPLAY_SNAPSHOTS_MIGRATION } from '../migrations/009_replay_snapshots.ts';

export interface ReplaySnapshotRecord {
  readonly snapshotId: string;
  readonly matchId: string;
  readonly tick: number;
  readonly checksumSha256: string;
  readonly stateHash: string;
  readonly stateJson: string;
  readonly createdAtUtc: string;
}

export interface ReplaySnapshotWrite {
  readonly snapshotId: string;
  readonly matchId: string;
  readonly tick: number;
  readonly checksumSha256: string;
  readonly stateHash: string;
  readonly stateJson: string;
}

interface RawSnapshotRow {
  readonly snapshot_id: string;
  readonly match_id: string;
  readonly tick: number;
  readonly checksum_sha256: string;
  readonly state_hash: string;
  readonly state_json: string;
  readonly created_at_utc: string;
}

function toRecord(row: RawSnapshotRow): ReplaySnapshotRecord {
  return {
    snapshotId: row.snapshot_id,
    matchId: row.match_id,
    tick: row.tick,
    checksumSha256: row.checksum_sha256,
    stateHash: row.state_hash,
    stateJson: row.state_json,
    createdAtUtc: row.created_at_utc,
  };
}

export class ReplaySnapshotRepository {
  constructor(private readonly db: Database) {
    this.ensureTable();
  }

  public ensureTable(): void {
    this.db.exec(REPLAY_SNAPSHOTS_MIGRATION.sql);
  }

  public saveSnapshot(write: ReplaySnapshotWrite): ReplaySnapshotRecord {
    const createdAtUtc = new Date().toISOString();
    const query = `
      INSERT INTO match_snapshots (
        snapshot_id, match_id, tick, checksum_sha256, state_hash, state_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id, tick) DO UPDATE SET
        checksum_sha256 = excluded.checksum_sha256,
        state_hash = excluded.state_hash,
        state_json = excluded.state_json,
        created_at_utc = excluded.created_at_utc
    `;
    this.db
      .query(query)
      .run(
        write.snapshotId,
        write.matchId,
        write.tick,
        write.checksumSha256,
        write.stateHash,
        write.stateJson,
        createdAtUtc
      );

    return {
      ...write,
      createdAtUtc,
    };
  }

  public getSnapshot(matchId: string, tick: number): ReplaySnapshotRecord | null {
    const row = this.db
      .query<RawSnapshotRow>(
        'SELECT * FROM match_snapshots WHERE match_id = ? AND tick = ?'
      )
      .get(matchId, tick);
    return row ? toRecord(row) : null;
  }

  public listSnapshots(matchId: string): readonly ReplaySnapshotRecord[] {
    const rows = this.db
      .query<RawSnapshotRow>(
        'SELECT * FROM match_snapshots WHERE match_id = ? ORDER BY tick ASC'
      )
      .all(matchId);
    return rows.map(toRecord);
  }

  public getLatestSnapshot(matchId: string): ReplaySnapshotRecord | null {
    const row = this.db
      .query<RawSnapshotRow>(
        'SELECT * FROM match_snapshots WHERE match_id = ? ORDER BY tick DESC LIMIT 1'
      )
      .get(matchId);
    return row ? toRecord(row) : null;
  }
}
