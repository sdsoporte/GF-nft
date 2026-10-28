# Hash-only MCP grant storage

Grant repositories store SHA-256 digests, never reusable bearer tokens. Migration
5 retires every legacy plaintext grant. Issuance policy is documented separately
in the following service work unit; HTTP administration remains T4.

## Quick path

1. Read `backend/src/mcp/credentials.ts` for secret, digest and metadata shapes.
2. Read `backend/src/persistence/repos/grants.ts` for validated transactional writes.
3. Run `bun test tests/persistence/grant-credentials.test.ts`.
4. Plan owner-authenticated reissuance before deploying migration 5.

## Repository contract

| Operation | Result |
| --- | --- |
| `save(McpGrant)` | Hashes the ephemeral raw input before binding SQL. |
| `saveStored(StoredMcpGrant)` | Accepts only a SHA-256 digest; rejects plaintext. |
| `load`, `loadByTokenHash`, `list` | Return policy plus `tokenHash`, never a raw token. |
| `toGrantPolicy` | Produces boundary-safe metadata without token or digest. |

`StoredMcpGrant` extends `McpGrantPolicy` with `tokenHash`. Only server-side
repository/resolver code may handle that stored form. Public metadata contains
neither `token` nor `tokenHash`. Credential generation uses 32 CSPRNG bytes and
SHA-256 of the whole `gf_mcp_` token; opaque IDs are generated independently.
The module is server-only and must not enter the browser import graph.

## Migration 5: mandatory retirement and reissuance

Migration `005_mcp_grant_token_hash` renames `mcp_grants.token` to `token_hash`,
then overwrites every old value with an unusable random 32-byte hex placeholder
and sets `revoked = 1`. It does not drop a table or rewrite the version-1 baseline
in `schema.sql`/migration 1.

Preserved: grant IDs, owner/player/company/match, phase, scopes, allowlist,
quotas, timestamps and every audit row/link. Existing transaction/migration
helpers preserve atomicity and roll back a failing migration.

**Deployment consequence:** every pre-v5 grant becomes unusable. It must be
reissued through an authenticated owner session once T4 endpoints are available.
Do not deploy this migration ahead of that administration path. No live database
or real credential was changed during this implementation. This is logical
credential retirement, not a claim of forensic erasure of historical backups.

## Evidence

Public credential/repository/migrator tests cover fresh and populated v4
migration, rejected plaintext digests, preserved metadata/audit links, rollback,
close/reopen durability and duplicate-digest uniqueness. Legacy SQL is fixture
setup only; assertions use the public APIs.
