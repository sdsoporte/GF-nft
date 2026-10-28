/**
 * MCP grant credentials (S9/S11): opaque secret generation and hash-only
 * storage shape.
 *
 * The secret is generated here and leaves the server exactly once, in the
 * response of `GrantService.issue`. Everything the persistence layer, the
 * administrative read APIs and the gateway resolver can see is `StoredMcpGrant`,
 * which carries `tokenHash` (SHA-256 of the full `gf_mcp_...` token) and never a
 * reusable credential. `McpGrantPolicy` is the same record without the hash: it
 * is the only shape that may cross an API boundary.
 *
 * A well-formed token is `gf_mcp_` plus the base64url encoding of 32 random
 * bytes (43 characters, no padding). Fixture/demo credentials such as
 * `gf_mcp_token_1` or `gf_mcp_metal01_live_token` are deliberately outside that
 * shape, so the resolver rejects them before touching storage (S17).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { McpPhaseMode, McpQuotas, McpScope } from './types.ts';

export const MCP_TOKEN_PREFIX = 'gf_mcp_';

/** 32 random bytes encode to 43 unpadded base64url characters. */
export const MCP_TOKEN_SECRET_LENGTH = 43;

const MCP_TOKEN_PATTERN = /^gf_mcp_[A-Za-z0-9_-]{43}$/;
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Grant policy as stored and re-read from the database (no secret). */
export interface McpGrantPolicy {
  readonly grantId: string;
  readonly playerId: string;
  readonly companyId: string;
  readonly matchId: string;
  readonly phaseMode: McpPhaseMode;
  readonly scopes: readonly McpScope[];
  readonly resourceAllowlist: readonly string[];
  readonly quotas: McpQuotas;
  readonly createdAtUtc: string;
  readonly expiresAtUtc: string;
  readonly revoked: boolean;
}

/** Durable grant record: the policy plus the digest of the issued secret. */
export interface StoredMcpGrant extends McpGrantPolicy {
  readonly tokenHash: string;
}

/** Generate a fresh opaque secret; the only call site that produces one. */
export function generateMcpToken(): string {
  return `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Stable opaque grant identifier for a newly issued grant. */
export function generateGrantId(): string {
  return randomUUID();
}

/** SHA-256 of the full token, hex encoded (the only secret-derived value stored). */
export function hashMcpToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True only for `gf_mcp_` + 32 random bytes in base64url form. */
export function isWellFormedMcpToken(value: unknown): value is string {
  return typeof value === 'string' && MCP_TOKEN_PATTERN.test(value);
}

/** True for a stored SHA-256 digest. */
export function isTokenHash(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_HASH_PATTERN.test(value);
}

/** Attach a digest to a policy, producing the durable storage record. */
export function withTokenHash(policy: McpGrantPolicy, tokenHash: string): StoredMcpGrant {
  return { ...policy, tokenHash };
}

/**
 * Drop the digest, leaving the public/administrative metadata. Returned objects
 * are built by field so a stray extra property can never be forwarded.
 */
export function toGrantPolicy(grant: StoredMcpGrant): McpGrantPolicy {
  return {
    grantId: grant.grantId,
    playerId: grant.playerId,
    companyId: grant.companyId,
    matchId: grant.matchId,
    phaseMode: grant.phaseMode,
    scopes: [...grant.scopes],
    resourceAllowlist: [...grant.resourceAllowlist],
    quotas: { ...grant.quotas },
    createdAtUtc: grant.createdAtUtc,
    expiresAtUtc: grant.expiresAtUtc,
    revoked: grant.revoked,
  };
}

/** True when the grant's expiry is at or before `nowMs` (exact expiry denies). */
export function isGrantExpired(grant: Pick<McpGrantPolicy, 'expiresAtUtc'>, nowMs: number): boolean {
  return Date.parse(grant.expiresAtUtc) <= nowMs;
}
