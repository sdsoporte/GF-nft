/**
 * Migration 5 — "mcp_grant_token_hash": retire every plaintext grant secret.
 *
 * Before this version `mcp_grants.token` held the reusable `gf_mcp_...`
 * credential in the clear. The column is renamed to `token_hash` so the storage
 * shape matches `StoredMcpGrant` (SHA-256 digest only), and every existing row
 * is (a) revoked and (b) given a fresh random 32-byte digest placeholder.
 *
 * Why placeholders instead of leaving the old values or NULL: the column is
 * `NOT NULL UNIQUE`, the legacy values must not survive anywhere, and the
 * placeholder must not be derivable from a known secret. A retired row can
 * therefore never be resolved by any presented token, while its id, owner,
 * company, match, scopes, allowlist, quotas, timestamps, audit rows and audit
 * links stay exactly as they were.
 *
 * Deployment consequence: after this migration runs, every previously issued
 * grant is dead and must be reissued through `GrantService.issue`. That is
 * documented in `docs/mcp-grant-storage.md`; no deployment is performed here.
 *
 * `schema.sql`/migration 1 are the documented baseline and stay untouched.
 */

import type { Migration } from '../migrations.ts';

const SQL = `
ALTER TABLE mcp_grants RENAME COLUMN token TO token_hash;

UPDATE mcp_grants
   SET token_hash = lower(hex(randomblob(32))),
       revoked = 1;
`;

export const MCP_GRANT_TOKEN_HASH_MIGRATION: Migration = {
  version: 5,
  name: 'mcp_grant_token_hash',
  sql: SQL,
};
