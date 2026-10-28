/**
 * Server-issued MCP grant lifecycle (S9/S11/S14-S17).
 *
 * `GrantService` is the only producer of real grant secrets. These tests bind
 * it to a migrated SQLite database and assert the two properties a reviewer
 * cannot see from types alone: the secret appears in exactly one response and
 * never in storage or metadata, and the resolver answers strictly inside the
 * server-configured owner/company/match/line context.
 *
 * The resolver intentionally returns revoked and expired grants with their
 * flags set: the gateway owns the denial codes, so expiry and revocation are
 * asserted as data here, not as `undefined`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_MCP_QUOTAS,
  GRANT_ISSUE_ERROR_CODE,
  GrantIssueError,
  GrantService,
  MAX_GRANT_TTL_MS,
  MAX_MCP_QUOTAS,
  type GrantIssueInput,
  type GrantServiceOptions,
} from '../src/grantService.ts';
import type { McpGrantPolicy, StoredMcpGrant } from '../../src/mcp/credentials.ts';
import { closeDatabase, openDatabase } from '../../src/persistence/database.ts';
import { migrate, MIGRATIONS } from '../../src/persistence/migrations.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repos/index.ts';

/** The sqlite handle type the persistence layer exposes (no ambient import here). */
type Database = Repositories['database'];

const OWNER_ID = 'player_owner_01';
const MATCH_ID = 'match_grant_01';
const COMPANY_ID = 'comp_metal_01';
const OTHER_COMPANY_ID = 'comp_factory_02';
const ALLOWED_LINE_IDS = ['line_1', 'line_2'] as const;
const CREATED_AT_UTC = '2026-01-01T00:00:00.000Z';
const CREATED_AT_MS = Date.parse(CREATED_AT_UTC);

interface ManualClock {
  readonly now: () => Date;
  advance(ms: number): void;
}

function manualClock(startMs: number = CREATED_AT_MS): ManualClock {
  let currentMs = startMs;
  return {
    now: () => new Date(currentMs),
    advance(ms: number) {
      currentMs += ms;
    },
  };
}

function withTempDatabase(work: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'gf-grant-service-'));
  try {
    work(join(directory, 'factory.db'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** Minimal company rows so the grant foreign key is satisfied. */
function seedCompanies(database: Database): void {
  const insert = database.query(
    `INSERT OR IGNORE INTO companies (company_id, name, industrial_class, created_at_utc, updated_at_utc)
     VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  );
  insert.run(COMPANY_ID, 'Metal One', 'CLASS_A_METALLURGY');
  insert.run(OTHER_COMPANY_ID, 'Factory Two', 'CLASS_B_MANUFACTURING');
}

function openMigrated(path: string): { database: Database; repositories: Repositories } {
  const database = openDatabase(path);
  migrate(database);
  seedCompanies(database);
  return { database, repositories: createRepositories(database) };
}

function makeService(
  repositories: Repositories,
  overrides: Partial<GrantServiceOptions> = {},
): GrantService {
  return new GrantService({
    repositories,
    ownerId: OWNER_ID,
    matchId: MATCH_ID,
    companyId: COMPANY_ID,
    allowedLineIds: ALLOWED_LINE_IDS,
    now: manualClock().now,
    ...overrides,
  });
}

function grantCount(database: Database): number {
  return database.query<{ count: number }>('SELECT COUNT(*) AS count FROM mcp_grants').get()!.count;
}

function rawGrantRows(database: Database): Record<string, unknown>[] {
  return database.query<Record<string, unknown>>('SELECT * FROM mcp_grants ORDER BY grant_id').all();
}

function readWriteInput(overrides: Partial<GrantIssueInput> = {}): GrantIssueInput {
  return {
    phaseMode: 'PHASE_1B_READ_WRITE',
    scopes: ['factory:read', 'production:write'],
    ...overrides,
  };
}

// --- issuance ---------------------------------------------------------------

test('issue returns the secret once and stores only its sha256 digest', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const issued = service.issue(readWriteInput({ resourceAllowlist: ['line_2'] }));

      assert.match(issued.token, /^gf_mcp_[A-Za-z0-9_-]{43}$/);
      assert.equal(issued.grant.playerId, OWNER_ID);
      assert.equal(issued.grant.companyId, COMPANY_ID);
      assert.equal(issued.grant.matchId, MATCH_ID);
      assert.equal(issued.grant.phaseMode, 'PHASE_1B_READ_WRITE');
      assert.deepEqual(issued.grant.scopes, ['factory:read', 'production:write']);
      assert.deepEqual(issued.grant.resourceAllowlist, ['line_2']);
      assert.deepEqual(issued.grant.quotas, DEFAULT_MCP_QUOTAS);
      assert.equal(issued.grant.createdAtUtc, CREATED_AT_UTC);
      assert.equal(issued.grant.expiresAtUtc, new Date(CREATED_AT_MS + DEFAULT_GRANT_TTL_MS).toISOString());
      assert.equal(issued.grant.revoked, false);
      assert.equal('token' in issued.grant, false);
      assert.equal('tokenHash' in issued.grant, false);
      assert.equal(JSON.stringify(issued.grant).includes(issued.token), false);

      const [row] = rawGrantRows(database);
      assert.deepEqual(Object.keys(row).sort(), [
        'company_id',
        'created_at_utc',
        'expires_at_utc',
        'grant_id',
        'match_id',
        'max_read_per_minute',
        'max_write_per_match',
        'max_write_per_minute',
        'phase_mode',
        'player_id',
        'resource_allowlist_json',
        'revoked',
        'scopes_json',
        'token_hash',
      ]);
      const expectedHash = createHash('sha256').update(issued.token, 'utf8').digest('hex');
      assert.equal(row.token_hash, expectedHash);
      assert.equal(JSON.stringify(row).includes(issued.token), false);

      const stored = repositories.grants.load(issued.grant.grantId);
      assert.equal(stored?.tokenHash, expectedHash);
      assert.equal(JSON.stringify(stored).includes(issued.token), false);
    } finally {
      closeDatabase(database);
    }
  });
});

test('issue defaults the allowlist to every server-allowed line and accepts bounded overrides', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const defaulted = service.issue({ phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'] });
      assert.deepEqual(defaulted.grant.resourceAllowlist, [...ALLOWED_LINE_IDS]);

      const narrowed = service.issue({
        phaseMode: 'PHASE_1_READ_ONLY',
        scopes: ['factory:read'],
        resourceAllowlist: ['line_2'],
      });
      assert.deepEqual(narrowed.grant.resourceAllowlist, ['line_2']);
      assert.equal(narrowed.grant.grantId === defaulted.grant.grantId, false);
      assert.equal(narrowed.token === defaulted.token, false);
    } finally {
      closeDatabase(database);
    }
  });
});

test('issue honours a bounded TTL and bounded quotas', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const clock = manualClock();
      const service = makeService(repositories, { now: clock.now });
      const issued = service.issue({
        phaseMode: 'PHASE_1_READ_ONLY',
        scopes: ['factory:read'],
        ttlMs: 90 * 60 * 1000,
        quotas: { maxReadPerMinute: 30 },
      });
      assert.equal(issued.grant.expiresAtUtc, new Date(CREATED_AT_MS + 90 * 60 * 1000).toISOString());
      assert.deepEqual(issued.grant.quotas, { ...DEFAULT_MCP_QUOTAS, maxReadPerMinute: 30 });

      clock.advance(1_000);
      const later = service.issue({ phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'] });
      assert.equal(later.grant.createdAtUtc, new Date(CREATED_AT_MS + 1_000).toISOString());
      assert.equal(
        later.grant.expiresAtUtc,
        new Date(CREATED_AT_MS + 1_000 + DEFAULT_GRANT_TTL_MS).toISOString(),
      );
    } finally {
      closeDatabase(database);
    }
  });
});

test('issue rejects caller-chosen identity, secret or match fields and writes nothing', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const before = grantCount(database);
      const smuggled = [
        { token: 'gf_mcp_attacker_supplied_token' },
        { playerId: 'player_attacker' },
        { ownerId: 'player_attacker' },
        { companyId: OTHER_COMPANY_ID },
        { matchId: 'match_attacker' },
        { grantId: 'grant_attacker' },
        { revoked: true },
        { allowedLineIds: ['line_9'] },
      ];
      for (const extra of smuggled) {
        assert.throws(
          () => service.issue({ ...readWriteInput(), ...extra } as GrantIssueInput),
          (error: unknown) => {
            assert.equal(error instanceof GrantIssueError, true);
            assert.equal((error as GrantIssueError).code, GRANT_ISSUE_ERROR_CODE);
            return true;
          },
          `accepted smuggled field ${Object.keys(extra)[0]}`,
        );
      }
      assert.equal(grantCount(database), before);
    } finally {
      closeDatabase(database);
    }
  });
});

test('issue rejects invalid phase, scopes, TTL, quotas and allowlist without writing', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const before = grantCount(database);
      const invalid: GrantIssueInput[] = [
        { phaseMode: 'PHASE_0_BOGUS' as never, scopes: ['factory:read'] },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read', 'production:write'] },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['contracts:draft'] },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: [] },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read', 'factory:read'] },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['admin:everything' as never] },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], ttlMs: 0 },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], ttlMs: -1 },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], ttlMs: 1.5 },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], ttlMs: MAX_GRANT_TTL_MS + 1 },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], quotas: { maxReadPerMinute: 0 } },
        {
          phaseMode: 'PHASE_1_READ_ONLY',
          scopes: ['factory:read'],
          quotas: { maxReadPerMinute: MAX_MCP_QUOTAS.maxReadPerMinute + 1 },
        },
        {
          phaseMode: 'PHASE_1_READ_ONLY',
          scopes: ['factory:read'],
          quotas: { maxWritePerMinute: 1.5 },
        },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], resourceAllowlist: ['line_9'] },
        {
          phaseMode: 'PHASE_1_READ_ONLY',
          scopes: ['factory:read'],
          resourceAllowlist: ['line_1', 'line_9'],
        },
        { phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], resourceAllowlist: ['line 2'] },
      ];
      for (const input of invalid) {
        assert.throws(
          () => service.issue(input),
          (error: unknown) => {
            assert.equal(error instanceof GrantIssueError, true);
            assert.equal((error as GrantIssueError).code, GRANT_ISSUE_ERROR_CODE);
            return true;
          },
          `accepted invalid input ${JSON.stringify(input)}`,
        );
      }
      assert.equal(grantCount(database), before);
    } finally {
      closeDatabase(database);
    }
  });
});

test('issue requires a valid trusted context at construction', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const invalidContexts: Partial<GrantServiceOptions>[] = [
        { ownerId: '' },
        { ownerId: '   ' },
        { matchId: '' },
        { companyId: '' },
        { allowedLineIds: [] },
        { allowedLineIds: ['line_1', 'line_1'] },
        { allowedLineIds: ['line 1'] },
      ];
      for (const overrides of invalidContexts) {
        assert.throws(
          () => makeService(repositories, overrides),
          /./,
          JSON.stringify(overrides),
        );
      }
      assert.equal(grantCount(database), 0);
    } finally {
      closeDatabase(database);
    }
  });
});

// --- administrative reads ---------------------------------------------------

test('list and get expose policy only, never the secret or its digest', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const first = service.issue(readWriteInput({ resourceAllowlist: ['line_1'] }));
      const second = service.issue({ phaseMode: 'PHASE_1_READ_ONLY', scopes: ['inventory:read'] });

      const listed = service.list();
      // `list()` follows the repository's grant_id ordering, not issue order.
      assert.deepEqual(
        listed.map((grant) => grant.grantId).sort(),
        [first.grant.grantId, second.grant.grantId].sort(),
      );
      assert.deepEqual(service.get(first.grant.grantId), first.grant);
      assert.equal(service.get('grant_missing'), undefined);

      const wire = JSON.stringify([listed, service.get(first.grant.grantId)]);
      assert.equal(wire.includes(first.token), false);
      assert.equal(wire.includes(second.token), false);
      assert.equal(wire.includes('tokenHash'), false);
      assert.equal(wire.includes('token'), false);
      for (const grant of listed) {
        assert.equal('token' in grant, false);
        assert.equal('tokenHash' in grant, false);
        assert.deepEqual(Object.keys(grant).sort(), Object.keys(first.grant).sort());
      }
    } finally {
      closeDatabase(database);
    }
  });
});

// --- resolution -------------------------------------------------------------

test('resolve returns the stored policy for the issued secret', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const issued = service.issue(readWriteInput({ resourceAllowlist: ['line_2'] }));

      const resolved = service.resolve(issued.token);
      assert.deepEqual(resolved?.grant, issued.grant);
      assert.equal(resolved?.expired, false);
      assert.equal(resolved?.revoked, false);
      assert.equal(JSON.stringify(resolved).includes('tokenHash'), false);
    } finally {
      closeDatabase(database);
    }
  });
});

test('resolve reads the stored policy fresh instead of caching the issue result', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const issued = service.issue(readWriteInput());
      const stored = repositories.grants.load(issued.grant.grantId);
      assert.ok(stored);

      const updated: StoredMcpGrant = {
        ...stored,
        scopes: ['inventory:read'],
        quotas: { maxReadPerMinute: 5, maxWritePerMinute: 1, maxWritePerMatch: 7 },
      };
      repositories.grants.saveStored(updated);

      const resolved = service.resolve(issued.token);
      assert.deepEqual(resolved?.grant.scopes, ['inventory:read']);
      assert.deepEqual(resolved?.grant.quotas, updated.quotas);
    } finally {
      closeDatabase(database);
    }
  });
});

test('resolve keeps revoked and expired grants visible with their flags', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const clock = manualClock();
      const service = makeService(repositories, { now: clock.now });
      const expiring = service.issue({ phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'], ttlMs: 60_000 });
      const revoked = service.issue({ phaseMode: 'PHASE_1_READ_ONLY', scopes: ['factory:read'] });

      assert.equal(service.revoke(revoked.grant.grantId), true);
      const revokedResolution = service.resolve(revoked.token);
      assert.equal(revokedResolution?.revoked, true);
      assert.equal(revokedResolution?.expired, false);

      clock.advance(60_000);
      const expiredResolution = service.resolve(expiring.token);
      assert.equal(expiredResolution?.expired, true);
      assert.equal(expiredResolution?.revoked, false);
      assert.equal(expiredResolution?.grant.revoked, false);
    } finally {
      closeDatabase(database);
    }
  });
});

test('resolve rejects unknown, malformed and mock credentials', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      service.issue(readWriteInput());
      for (const candidate of [
        'gf_mcp_never_issued_token_for_tests',
        'gf_mcp_metal01_live_token',
        'gf_mcp_token_1',
        'gf_mcp_',
        'GF_MCP_' + 'a'.repeat(43),
        'gf_mcp_' + 'a'.repeat(43),
        '',
        undefined as unknown as string,
        42 as unknown as string,
      ]) {
        assert.equal(service.resolve(candidate), undefined, `resolved ${String(candidate)}`);
      }
    } finally {
      closeDatabase(database);
    }
  });
});

test('resolve and administration stay inside the server-selected owner, company and match', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const own = service.issue(readWriteInput());

      const foreign = [
        { playerId: 'player_attacker' },
        { companyId: OTHER_COMPANY_ID },
        { matchId: 'match_attacker' },
        { companyId: OTHER_COMPANY_ID, playerId: 'player_attacker' },
      ];
      foreign.forEach((overrides, index) => {
        const token = makeWellFormedToken(index);
        repositories.grants.saveStored({
          ...storedPolicy(own.grant),
          ...overrides,
          grantId: `grant_foreign_${index}`,
          tokenHash: createHash('sha256').update(token, 'utf8').digest('hex'),
        });
        assert.equal(service.resolve(token), undefined, JSON.stringify(overrides));
      });

      assert.deepEqual(
        service.list().map((grant) => grant.grantId),
        [own.grant.grantId],
      );
      for (const overrides of foreign) {
        assert.equal(service.get(`grant_foreign_${foreign.indexOf(overrides)}`), undefined);
      }

      const otherContext = makeService(repositories, {
        companyId: OTHER_COMPANY_ID,
        matchId: 'match_attacker',
        ownerId: 'player_attacker',
      });
      assert.deepEqual(otherContext.list(), []);
      assert.equal(otherContext.resolve(own.token), undefined);
    } finally {
      closeDatabase(database);
    }
  });
});

test('revoke only affects grants of the trusted context', () => {
  withTempDatabase((path) => {
    const { database, repositories } = openMigrated(path);
    try {
      const service = makeService(repositories);
      const own = service.issue(readWriteInput());
      const foreignToken = makeWellFormedToken(9);
      repositories.grants.saveStored({
        ...storedPolicy(own.grant),
        grantId: 'grant_foreign_revoke',
        playerId: 'player_attacker',
        tokenHash: createHash('sha256').update(foreignToken, 'utf8').digest('hex'),
      });

      assert.equal(service.revoke('grant_missing'), false);
      assert.equal(service.revoke('grant_foreign_revoke'), false);
      assert.equal(repositories.grants.load('grant_foreign_revoke')?.revoked, false);
      assert.equal(service.revoke(own.grant.grantId), true);
      assert.equal(service.revoke(own.grant.grantId), true);
      assert.equal(repositories.grants.load(own.grant.grantId)?.revoked, true);
    } finally {
      closeDatabase(database);
    }
  });
});

// --- durability and storage invariants --------------------------------------

test('issued grants survive close and reopen with the same digest', () => {
  withTempDatabase((path) => {
    const first = openMigrated(path);
    let token = '';
    let issued: McpGrantPolicy;
    let digest = '';
    try {
      const service = makeService(first.repositories);
      const result = service.issue(readWriteInput());
      token = result.token;
      issued = result.grant;
      digest = createHash('sha256').update(token, 'utf8').digest('hex');
      assert.equal(first.repositories.grants.load(issued.grantId)?.tokenHash, digest);
    } finally {
      closeDatabase(first.database);
    }

    const second = openMigrated(path);
    try {
      const service = makeService(second.repositories);
      const resolved = service.resolve(token);
      assert.deepEqual(resolved?.grant, issued);
      assert.equal(second.repositories.grants.loadByTokenHash(digest)?.grantId, issued.grantId);
      assert.equal(JSON.stringify(second.repositories.grants.list()).includes(token), false);
      assert.equal(JSON.stringify(rawGrantRows(second.database)).includes(token), false);
    } finally {
      closeDatabase(second.database);
    }
  });
});

test('a retired legacy grant keeps its metadata but its old secret no longer resolves', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      // v4 state: the plaintext token is still in the legacy column.
      migrate(database, MIGRATIONS.slice(0, 4));
      seedCompanies(database);
      const legacyToken = makeWellFormedToken(1);
      database
        .query(
          `INSERT INTO mcp_grants (grant_id, token, player_id, company_id, match_id, phase_mode,
             scopes_json, resource_allowlist_json, max_read_per_minute, max_write_per_minute,
             max_write_per_match, created_at_utc, expires_at_utc, revoked)
           VALUES ('grant_legacy_1', ?, ?, ?, ?, 'PHASE_1_READ_ONLY', ?, ?, 60, 12, 500,
             '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 0)`,
        )
        .run(
          legacyToken,
          OWNER_ID,
          COMPANY_ID,
          MATCH_ID,
          JSON.stringify(['factory:read']),
          JSON.stringify(['line_1']),
        );

      migrate(database);
      const service = makeService(createRepositories(database));

      // The old secret is gone even though it was well-formed and the grant
      // still matches the trusted owner/company/match.
      assert.equal(service.resolve(legacyToken), undefined);
      assert.equal(JSON.stringify(rawGrantRows(database)).includes(legacyToken), false);

      const retired = service.get('grant_legacy_1');
      assert.equal(retired?.revoked, true);
      assert.equal(retired?.expiresAtUtc, '2026-02-01T00:00:00.000Z');
      assert.deepEqual(retired?.scopes, ['factory:read']);
    } finally {
      closeDatabase(database);
    }
  });
});

/** A deterministically unique, well-formed token for storage-only fixtures. */
function makeWellFormedToken(seed: number): string {
  const secret = createHash('sha256').update(`fixture-${seed}`).digest('base64url');
  return `gf_mcp_${secret}`;
}

function storedPolicy(policy: McpGrantPolicy): McpGrantPolicy {
  return {
    grantId: policy.grantId,
    playerId: policy.playerId,
    companyId: policy.companyId,
    matchId: policy.matchId,
    phaseMode: policy.phaseMode,
    scopes: policy.scopes,
    resourceAllowlist: policy.resourceAllowlist,
    quotas: policy.quotas,
    createdAtUtc: policy.createdAtUtc,
    expiresAtUtc: policy.expiresAtUtc,
    revoked: policy.revoked,
  };
}
