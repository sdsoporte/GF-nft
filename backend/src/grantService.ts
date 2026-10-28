/**
 * Server-issued MCP grants (S9/S11/S14-S17).
 *
 * `GrantService` is the only producer of real grant secrets. It is constructed
 * with a trusted server context — the configured owner, the company and match
 * the server selected, and the production lines that owner may ever reach — so
 * no request body can choose an identity, match, company, player or token.
 *
 * Lifecycle:
 * - `issue(input)` validates phase/scopes/TTL/quotas/allowlist, generates a
 *   32-byte CSPRNG secret, stores only its SHA-256 digest and returns the secret
 *   exactly once next to safe public metadata.
 * - `list()`/`get()` return the same metadata and never a secret or digest.
 * - `revoke()` only touches grants of the trusted context and is idempotent.
 * - `resolve(token)` is a *resolver*, not an authorization decision: it filters
 *   malformed/mock credentials and grants of another owner/company/match, then
 *   returns the freshly stored policy with `expired`/`revoked` flags intact so
 *   the gateway can emit its exact denial codes.
 *
 * Exact policy defaults (documented in `docs/mcp-grant-storage.md`):
 * - TTL: 24 h when omitted, bounded to (0, 30 d].
 * - Quotas: the existing 60 reads/min, 12 writes/min, 500 writes/match defaults,
 *   bounded to 600/120/1000 so one grant cannot out-scale the server.
 * - Allowlist: every server-allowed line when omitted; a requested list must be
 *   a subset of those lines, so a grant can only narrow its reach.
 */

import type { GrantRepository } from '../../src/persistence/repos/grants.ts';
import {
  generateGrantId,
  generateMcpToken,
  hashMcpToken,
  isGrantExpired,
  isWellFormedMcpToken,
  toGrantPolicy,
  withTokenHash,
  type McpGrantPolicy,
  type StoredMcpGrant,
} from '../../src/mcp/credentials.ts';
import { CompanyIdSchema, LineIdSchema } from '../../src/mcp/schemas.ts';
import type { McpErrorCode, McpPhaseMode, McpQuotas, McpScope } from '../../src/mcp/types.ts';

export const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const DEFAULT_MCP_QUOTAS: McpQuotas = {
  maxReadPerMinute: 60,
  maxWritePerMinute: 12,
  maxWritePerMatch: 500,
};

export const MAX_MCP_QUOTAS: McpQuotas = {
  maxReadPerMinute: 600,
  maxWritePerMinute: 120,
  maxWritePerMatch: 1000,
};

/** The gateway's payload error; issuance failures are request-shaped. */
export const GRANT_ISSUE_ERROR_CODE = 'ERR_INVALID_PAYLOAD' as const;

const PHASE_MODES: readonly McpPhaseMode[] = ['PHASE_1_READ_ONLY', 'PHASE_1B_READ_WRITE'];

/**
 * Runtime mirror of the `McpScope` union. `types.ts` is compile-time only, so
 * a scope added there must be added here as well; the READ_ONLY set below makes
 * the phase/scope pairing explicit instead of inferred.
 */
const MCP_SCOPES: readonly McpScope[] = [
  'factory:read',
  'inventory:read',
  'market:read',
  'production:write',
  'logistics:write',
  'contracts:draft',
];

const WRITE_SCOPES: readonly McpScope[] = [
  'production:write',
  'logistics:write',
  'contracts:draft',
];

const ISSUE_INPUT_KEYS = [
  'phaseMode',
  'scopes',
  'ttlMs',
  'resourceAllowlist',
  'quotas',
] as const;

const QUOTA_KEYS = ['maxReadPerMinute', 'maxWritePerMinute', 'maxWritePerMatch'] as const;

/** Raised for every rejected issue request; the message names the cause. */
export class GrantIssueError extends Error {
  readonly code: McpErrorCode = GRANT_ISSUE_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'GrantIssueError';
  }
}

export interface GrantIssueInput {
  readonly phaseMode: McpPhaseMode;
  readonly scopes: readonly McpScope[];
  readonly ttlMs?: number;
  readonly resourceAllowlist?: readonly string[];
  readonly quotas?: Partial<McpQuotas>;
}

/** The one response that carries a usable secret. */
export interface IssuedMcpGrant {
  readonly token: string;
  readonly grant: McpGrantPolicy;
}

/** Result of resolving a presented credential; not an authorization decision. */
export interface ResolvedMcpGrant {
  readonly grant: McpGrantPolicy;
  readonly expired: boolean;
  readonly revoked: boolean;
}

export interface GrantServiceOptions {
  readonly repositories: { readonly grants: GrantRepository };
  /** The single configured owner; the grant's `playerId` is always this value. */
  readonly ownerId: string;
  readonly matchId: string;
  readonly companyId: string;
  /** Every line id this owner may ever reach in this match. */
  readonly allowedLineIds: readonly string[];
  readonly now?: () => Date;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`GrantService requires a non-empty ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class GrantService {
  private readonly repositories: { readonly grants: GrantRepository };
  private readonly ownerId: string;
  private readonly matchId: string;
  private readonly companyId: string;
  private readonly allowedLineIds: readonly string[];
  private readonly allowedLineIdSet: ReadonlySet<string>;
  private readonly now: () => Date;

  constructor(options: GrantServiceOptions) {
    requireNonEmpty(options.ownerId, 'ownerId');
    requireNonEmpty(options.matchId, 'matchId');
    requireNonEmpty(options.companyId, 'companyId');
    if (!CompanyIdSchema.safeParse(options.companyId).success) {
      throw new Error(`GrantService requires a valid companyId, received "${options.companyId}"`);
    }
    const lines = options.allowedLineIds;
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new Error('GrantService requires at least one allowed line id');
    }
    for (const lineId of lines) {
      if (!LineIdSchema.safeParse(lineId).success) {
        throw new Error(`GrantService requires valid line ids, received "${String(lineId)}"`);
      }
    }
    if (new Set(lines).size !== lines.length) {
      throw new Error('GrantService allowedLineIds must not contain duplicates');
    }

    this.repositories = options.repositories;
    this.ownerId = options.ownerId;
    this.matchId = options.matchId;
    this.companyId = options.companyId;
    this.allowedLineIds = [...lines];
    this.allowedLineIdSet = new Set(lines);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Issue a grant inside the trusted context. The only caller-influenced values
   * are cost/scope knobs: phase, scopes, TTL, quotas and a narrowing allowlist.
   */
  issue(input: GrantIssueInput): IssuedMcpGrant {
    const request = this.validateIssueInput(input);
    const issuedAt = this.now().getTime();
    const token = generateMcpToken();
    const stored: StoredMcpGrant = withTokenHash(
      {
        grantId: generateGrantId(),
        playerId: this.ownerId,
        companyId: this.companyId,
        matchId: this.matchId,
        phaseMode: request.phaseMode,
        scopes: request.scopes,
        resourceAllowlist: request.resourceAllowlist,
        quotas: request.quotas,
        createdAtUtc: new Date(issuedAt).toISOString(),
        expiresAtUtc: new Date(issuedAt + request.ttlMs).toISOString(),
        revoked: false,
      },
      hashMcpToken(token),
    );

    this.repositories.grants.saveStored(stored);
    return { token, grant: toGrantPolicy(stored) };
  }

  /** Grants of the configured owner in the configured company and match. */
  list(): McpGrantPolicy[] {
    return this.repositories.grants
      .list({ matchId: this.matchId, companyId: this.companyId })
      .filter((grant) => this.isOwnedByContext(grant))
      .map(toGrantPolicy);
  }

  /** One grant of the configured context, or `undefined` (also for foreign ids). */
  get(grantId: string): McpGrantPolicy | undefined {
    const stored = this.repositories.grants.load(grantId);
    return stored && this.isOwnedByContext(stored) ? toGrantPolicy(stored) : undefined;
  }

  /**
   * Revoke one grant of the configured context. Returns `false` for unknown or
   * foreign ids so grant existence is not disclosed; repeating is harmless.
   */
  revoke(grantId: string): boolean {
    const stored = this.repositories.grants.load(grantId);
    if (!stored || !this.isOwnedByContext(stored)) return false;
    this.repositories.grants.revoke(grantId);
    return true;
  }

  /**
   * Resolve a presented credential to its *current* stored policy.
   *
   * Revoked and expired grants are returned with their flags set: the gateway
   * decides `ERR_AUTH_REVOKED`/`ERR_AUTH_EXPIRED`, so this method must not hide
   * them. Everything outside the trusted context, plus malformed or fixture
   * credentials, resolves to `undefined`.
   */
  resolve(token: string): ResolvedMcpGrant | undefined {
    if (!isWellFormedMcpToken(token)) return undefined;
    const stored = this.repositories.grants.loadByTokenHash(hashMcpToken(token));
    if (!stored || !this.isOwnedByContext(stored)) return undefined;
    return {
      grant: toGrantPolicy(stored),
      expired: isGrantExpired(stored, this.now().getTime()),
      revoked: stored.revoked,
    };
  }

  private isOwnedByContext(grant: Pick<StoredMcpGrant, 'playerId' | 'companyId' | 'matchId'>): boolean {
    return (
      grant.playerId === this.ownerId &&
      grant.companyId === this.companyId &&
      grant.matchId === this.matchId
    );
  }

  private validateIssueInput(input: GrantIssueInput): {
    readonly phaseMode: McpPhaseMode;
    readonly scopes: readonly McpScope[];
    readonly ttlMs: number;
    readonly resourceAllowlist: readonly string[];
    readonly quotas: McpQuotas;
  } {
    if (!isRecord(input)) {
      throw new GrantIssueError('MCP grant issue input must be an object');
    }
    for (const key of Object.keys(input)) {
      if (!(ISSUE_INPUT_KEYS as readonly string[]).includes(key)) {
        throw new GrantIssueError(
          `MCP grant issue input does not accept "${key}": identity, match and the secret ` +
            'come from the trusted server context',
        );
      }
    }

    const phaseMode = input.phaseMode;
    if (!PHASE_MODES.includes(phaseMode)) {
      throw new GrantIssueError(`Unknown MCP grant phase mode "${String(phaseMode)}"`);
    }

    const scopes = input.scopes;
    if (!Array.isArray(scopes) || scopes.length === 0) {
      throw new GrantIssueError('MCP grant issue input requires at least one scope');
    }
    const seenScopes = new Set<McpScope>();
    for (const scope of scopes) {
      if (!MCP_SCOPES.includes(scope)) {
        throw new GrantIssueError(`Unknown MCP scope "${String(scope)}"`);
      }
      if (seenScopes.has(scope)) {
        throw new GrantIssueError(`Duplicate MCP scope "${scope}"`);
      }
      if (phaseMode === 'PHASE_1_READ_ONLY' && WRITE_SCOPES.includes(scope)) {
        throw new GrantIssueError(`Scope "${scope}" cannot be granted in ${phaseMode}`);
      }
      seenScopes.add(scope);
    }

    const ttlMs = input.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_GRANT_TTL_MS) {
      throw new GrantIssueError(
        `MCP grant TTL must be an integer number of milliseconds in (0, ${MAX_GRANT_TTL_MS}]`,
      );
    }

    const quotas = this.validateQuotas(input.quotas);
    const resourceAllowlist = this.validateAllowlist(input.resourceAllowlist);
    return { phaseMode, scopes: [...seenScopes], ttlMs, resourceAllowlist, quotas };
  }

  private validateQuotas(requested: Partial<McpQuotas> | undefined): McpQuotas {
    if (requested !== undefined && !isRecord(requested)) {
      throw new GrantIssueError('MCP grant quotas must be an object');
    }
    const quotas: McpQuotas = { ...DEFAULT_MCP_QUOTAS, ...(requested ?? {}) };
    for (const key of Object.keys(requested ?? {})) {
      if (!(QUOTA_KEYS as readonly string[]).includes(key)) {
        throw new GrantIssueError(`MCP grant issue input does not accept quota "${key}"`);
      }
    }
    for (const key of QUOTA_KEYS) {
      const value = quotas[key];
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MCP_QUOTAS[key]) {
        throw new GrantIssueError(
          `MCP grant quota ${key} must be an integer in (0, ${MAX_MCP_QUOTAS[key]}]`,
        );
      }
    }
    return quotas;
  }

  private validateAllowlist(requested: readonly string[] | undefined): readonly string[] {
    if (requested === undefined) return [...this.allowedLineIds];
    if (!Array.isArray(requested)) {
      throw new GrantIssueError('MCP grant resourceAllowlist must be an array of line ids');
    }
    const allowlist: string[] = [];
    const seen = new Set<string>();
    for (const lineId of requested) {
      if (!LineIdSchema.safeParse(lineId).success) {
        throw new GrantIssueError(`Invalid MCP grant line id "${String(lineId)}"`);
      }
      if (!this.allowedLineIdSet.has(lineId)) {
        throw new GrantIssueError(
          `Line "${lineId}" is outside the server-allowed line set for this owner`,
        );
      }
      if (seen.has(lineId)) {
        throw new GrantIssueError(`Duplicate MCP grant line id "${lineId}"`);
      }
      seen.add(lineId);
      allowlist.push(lineId);
    }
    return allowlist;
  }
}
