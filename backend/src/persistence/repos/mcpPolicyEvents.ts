/**
 * Durable MCP policy evidence (issue #15): append-only rows the gateway
 * consults at check time, so rate limits, per-match write quotas and per-line
 * cooldowns survive restarts and hold across every instance sharing the
 * database. Storage and evidence only; the decision logic lives in the
 * gateway, and rows are never updated or deleted.
 */

import type { Database } from 'bun:sqlite';

/** One consumed quota or line-action event, as recorded by the gateway. */
export interface McpPolicyEventWrite {
  readonly grantId: string;
  readonly kind: 'read' | 'write' | 'line_write';
  readonly atUtcMs: number;
  readonly matchId?: string;
  readonly companyId?: string;
  readonly lineId?: string;
  readonly tool?: string;
  /** Engine tick for line_write rows; the cooldown compares ticks. */
  readonly tick?: number;
}

export class McpPolicyEventRepository {
  constructor(private readonly database: Database) {}

  /** Append one event; failures roll back with the surrounding transaction. */
  record(event: McpPolicyEventWrite): void {
    this.database
      .query(
        `INSERT INTO mcp_policy_events
             (grant_id, kind, at_utc_ms, match_id, company_id, line_id, tool, tick)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.grantId,
        event.kind,
        event.atUtcMs,
        event.matchId ?? null,
        event.companyId ?? null,
        event.lineId ?? null,
        event.tool ?? null,
        event.tick ?? null
      );
  }

  /**
   * The engine tick of the last accepted line action, or undefined when the
   * line has never been acted on. This is what the per-line cooldown compares
   * against, so it must survive restarts and instances.
   */
  lastLineWriteTick(companyId: string, lineId: string, tool: string): number | undefined {
    const row = this.database
      .query(
        `SELECT MAX(tick) AS last_tick
         FROM mcp_policy_events
         WHERE kind = 'line_write' AND company_id = ? AND line_id = ? AND tool = ?
           AND tick IS NOT NULL`
      )
      .get(companyId, lineId, tool) as { last_tick: number | null } | undefined;
    const lastTick = row?.last_tick;
    return lastTick === null || lastTick === undefined ? undefined : lastTick;
  }

  /** Consumed writes for one grant inside the wall-clock window. */
  writeCountSince(grantId: string, sinceUtcMs: number): number {
    return (
      this.database
        .query(
          `SELECT COUNT(*) AS total
           FROM mcp_policy_events
           WHERE grant_id = ? AND kind = 'write' AND at_utc_ms > ?`
        )
        .get(grantId, sinceUtcMs) as { total: number }
    ).total;
  }

  /** Consumed reads for one grant inside the wall-clock window. */
  readCountSince(grantId: string, sinceUtcMs: number): number {
    return (
      this.database
        .query(
          `SELECT COUNT(*) AS total
           FROM mcp_policy_events
           WHERE grant_id = ? AND kind = 'read' AND at_utc_ms > ?`
        )
        .get(grantId, sinceUtcMs) as { total: number }
    ).total;
  }

  /** Consumed writes for one grant against one match (lifetime quota). */
  matchWriteCount(grantId: string, matchId: string): number {
    return (
      this.database
        .query(
          `SELECT COUNT(*) AS total
           FROM mcp_policy_events
           WHERE grant_id = ? AND kind = 'write' AND match_id = ?`
        )
        .get(grantId, matchId) as { total: number }
    ).total;
  }
}
