/**
 * `mcp_grants` + `mcp_audit_logs` repository.
 *
 * Grant secrets are never stored: `token_hash` holds the SHA-256 digest of the
 * issued `gf_mcp_...` token, and every read API returns `StoredMcpGrant`, which
 * has no raw-token field at all. The single write path that still accepts a
 * plaintext secret is `save(grant: McpGrant)`, kept for internal callers that
 * assemble an ephemeral grant: it hashes the secret before any SQL runs, so the
 * database never sees it. Real secrets are issued only by `GrantService`.
 *
 * `scopes_json` and `resource_allowlist_json` stay JSON because the columns are
 * lists of enum-ish strings with no relational use beyond membership, and both
 * are already documented that way in `schema.sql`. Everything else is columnar.
 *
 * Grants are upserted (revocation flips `revoked` in place); audit rows are
 * append-only and keyed by their own id.
 */

import type { Database } from 'bun:sqlite';

import { hashMcpToken, isTokenHash, type StoredMcpGrant } from '../../mcp/credentials.ts';
import type { McpAuditLogEntry, McpGrant } from '../../mcp/types.ts';
import { filterFlag, toMcpAuditLog, toStoredMcpGrant, type AuditLogRow, type GrantRow } from '../rows.ts';
import { runAtomic } from '../transaction.ts';
import { assertNonEmptyString } from './validate.ts';

const GRANT_COLUMNS = `grant_id, token_hash, player_id, company_id, match_id, phase_mode,
  scopes_json, resource_allowlist_json, max_read_per_minute, max_write_per_minute,
  max_write_per_match, created_at_utc, expires_at_utc, revoked`;

const SELECT_GRANT_SQL = `SELECT ${GRANT_COLUMNS} FROM mcp_grants WHERE grant_id = ?`;
const SELECT_GRANT_BY_TOKEN_HASH_SQL = `SELECT ${GRANT_COLUMNS} FROM mcp_grants WHERE token_hash = ?`;

const LIST_GRANTS_SQL = `SELECT ${GRANT_COLUMNS} FROM mcp_grants
WHERE (? = 1 OR match_id = ?)
  AND (? = 1 OR company_id = ?)
  AND (? = 1 OR revoked = ?)
ORDER BY grant_id`;

const UPSERT_GRANT_SQL = `
INSERT INTO mcp_grants (${GRANT_COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(grant_id) DO UPDATE SET
  token_hash = excluded.token_hash,
  player_id = excluded.player_id,
  company_id = excluded.company_id,
  match_id = excluded.match_id,
  phase_mode = excluded.phase_mode,
  scopes_json = excluded.scopes_json,
  resource_allowlist_json = excluded.resource_allowlist_json,
  max_read_per_minute = excluded.max_read_per_minute,
  max_write_per_minute = excluded.max_write_per_minute,
  max_write_per_match = excluded.max_write_per_match,
  created_at_utc = excluded.created_at_utc,
  expires_at_utc = excluded.expires_at_utc,
  revoked = excluded.revoked`;

const REVOKE_SQL = 'UPDATE mcp_grants SET revoked = 1 WHERE grant_id = ?';

const AUDIT_COLUMNS = `id, timestamp_utc, tick, grant_id, company_id, tool_name, payload_hash,
  idempotency_key, result_code, execution_time_ms`;

const INSERT_AUDIT_SQL = `
INSERT INTO mcp_audit_logs (${AUDIT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const LIST_AUDIT_SQL = `SELECT ${AUDIT_COLUMNS} FROM mcp_audit_logs
WHERE (? = 1 OR grant_id = ?)
  AND (? = 1 OR company_id = ?)
  AND (? = 1 OR tick = ?)
ORDER BY timestamp_utc ASC, id ASC`;

export interface GrantListFilter {
  readonly matchId?: string;
  readonly companyId?: string;
  /** `true` lists only revoked grants, `false` only live ones, absent lists both. */
  readonly revoked?: boolean;
}

export interface AuditListFilter {
  readonly grantId?: string;
  readonly companyId?: string;
  readonly tick?: number;
}

export class GrantRepository {
  constructor(private readonly database: Database) {}

  load(grantId: string): StoredMcpGrant | null {
    const row = this.database.query<GrantRow>(SELECT_GRANT_SQL).get(grantId);
    return row ? toStoredMcpGrant(row) : null;
  }

  /** Look up a grant by the SHA-256 digest of a presented token. */
  loadByTokenHash(tokenHash: string): StoredMcpGrant | null {
    const row = this.database.query<GrantRow>(SELECT_GRANT_BY_TOKEN_HASH_SQL).get(tokenHash);
    return row ? toStoredMcpGrant(row) : null;
  }

  list(filter: GrantListFilter = {}): StoredMcpGrant[] {
    const revokedFlag =
      filter.revoked === undefined ? undefined : filter.revoked ? 1 : 0;
    const rows = this.database
      .query<GrantRow>(LIST_GRANTS_SQL)
      .all(
        ...filterFlag(filter.matchId),
        ...filterFlag(filter.companyId),
        ...filterFlag(revokedFlag),
      );
    return rows.map(toStoredMcpGrant);
  }

  /**
   * Insert or update a grant from an ephemeral record carrying a plaintext
   * token. The secret is hashed here, before SQL, so it cannot reach a column,
   * a statement log or a bound parameter. Server code should prefer
   * `saveStored`, which already holds only the digest.
   */
  save(grant: McpGrant): void {
    assertNonEmptyString(grant.token, 'grant.token');
    this.saveStored({
      grantId: grant.grantId,
      tokenHash: hashMcpToken(grant.token),
      playerId: grant.playerId,
      companyId: grant.companyId,
      matchId: grant.matchId,
      phaseMode: grant.phaseMode,
      scopes: grant.scopes,
      resourceAllowlist: grant.resourceAllowlist,
      quotas: grant.quotas,
      createdAtUtc: grant.createdAtUtc,
      expiresAtUtc: grant.expiresAtUtc,
      revoked: grant.revoked,
    });
  }

  /** Insert or update a hash-only grant record (including `revoked`). */
  saveStored(grant: StoredMcpGrant): void {
    // Defence in depth: a plaintext secret must never reach the digest column,
    // even if a caller bypasses `save` and hands over a raw token by mistake.
    if (!isTokenHash(grant.tokenHash)) {
      throw new Error('grant.tokenHash must be a sha256 hex digest');
    }
    runAtomic(this.database, () => {
      this.database
        .query(UPSERT_GRANT_SQL)
        .run(
          grant.grantId,
          grant.tokenHash,
          grant.playerId,
          grant.companyId,
          grant.matchId,
          grant.phaseMode,
          JSON.stringify(grant.scopes),
          JSON.stringify(grant.resourceAllowlist),
          grant.quotas.maxReadPerMinute,
          grant.quotas.maxWritePerMinute,
          grant.quotas.maxWritePerMatch,
          grant.createdAtUtc,
          grant.expiresAtUtc,
          grant.revoked ? 1 : 0,
        );
    });
  }

  revoke(grantId: string): void {
    runAtomic(this.database, () => {
      const result = this.database.query(REVOKE_SQL).run(grantId);
      if (result.changes !== 1) {
        throw new Error(`MCP grant "${grantId}" not found`);
      }
    });
  }

  /** Append an audit row (never updated or deleted). */
  appendAudit(entry: McpAuditLogEntry): void {
    runAtomic(this.database, () => {
      this.database
        .query(INSERT_AUDIT_SQL)
        .run(
          entry.id,
          entry.timestampUtc,
          entry.tick,
          entry.grantId,
          entry.companyId,
          entry.toolName,
          entry.payloadHash,
          entry.idempotencyKey ?? null,
          entry.resultCode,
          entry.executionTimeMs,
        );
    });
  }

  listAudit(filter: AuditListFilter = {}): McpAuditLogEntry[] {
    const rows = this.database
      .query<AuditLogRow>(LIST_AUDIT_SQL)
      .all(
        ...filterFlag(filter.grantId),
        ...filterFlag(filter.companyId),
        ...filterFlag(filter.tick),
      );
    return rows.map(toMcpAuditLog);
  }
}
