/**
 * Hash-only MCP grant credentials (S9/S11): secret generation, digest helpers
 * and migration 5, which retires every legacy plaintext grant.
 *
 * The migration is exercised on a fresh database and on a v4 database seeded
 * with legacy plaintext grants plus their audit rows, because the two states a
 * future deployment will actually meet are "nothing yet" and "rows already
 * issued in the clear". Raw SQL appears only as fixture setup; every assertion
 * reads the migrated database.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MCP_TOKEN_PREFIX,
  generateGrantId,
  generateMcpToken,
  hashMcpToken,
  isTokenHash,
  isWellFormedMcpToken,
  toGrantPolicy,
  withTokenHash,
  type McpGrantPolicy,
  type StoredMcpGrant,
} from '../../src/mcp/credentials.ts';
import { closeDatabase, openDatabase } from '../../src/persistence/database.ts';
import {
  MIGRATIONS,
  getCurrentVersion,
  migrate,
  type Migration,
} from '../../src/persistence/migrations.ts';
import type { Repositories } from '../../src/persistence/repos/index.ts';

/** The sqlite handle type the persistence layer itself exposes (no direct import). */
type Database = Repositories['database'];

const LEGACY_GRANT_COLUMNS = `grant_id, token, player_id, company_id, match_id, phase_mode,
  scopes_json, resource_allowlist_json, max_read_per_minute, max_write_per_minute,
  max_write_per_match, created_at_utc, expires_at_utc, revoked`;

const INSERT_LEGACY_GRANT_SQL = `INSERT INTO mcp_grants (${LEGACY_GRANT_COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_LEGACY_AUDIT_SQL = `INSERT INTO mcp_audit_logs (id, timestamp_utc, tick, grant_id,
  company_id, tool_name, payload_hash, idempotency_key, result_code, execution_time_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Legacy tokens 1 and 2 are shaped like the old plaintext secrets. */
const LEGACY_TOKENS = ['gf_mcp_legacy_token_alpha', 'gf_mcp_metal01_live_token'] as const;

function withTempDatabase(work: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'gf-grant-credentials-'));
  try {
    work(join(directory, 'factory.db'));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function listColumns(database: Database, table: string): string[] {
  return database
    .query<{ name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((row: { readonly name: string }) => row.name);
}

function seedCompany(database: Database, companyId = 'comp_metal_01'): void {
  database
    .query(
      `INSERT INTO companies (company_id, name, industrial_class, created_at_utc, updated_at_utc)
       VALUES (?, 'Metal One', 'CLASS_A_METALLURGY', '2026-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z')`,
    )
    .run(companyId);
}

function insertLegacyGrant(
  database: Database,
  grantId: string,
  token: string,
  overrides: { readonly revoked?: number; readonly allowlist?: string } = {},
): void {
  database
    .query(INSERT_LEGACY_GRANT_SQL)
    .run(
      grantId,
      token,
      'player_1',
      'comp_metal_01',
      'match_test',
      'PHASE_1B_READ_WRITE',
      JSON.stringify(['factory:read', 'production:write']),
      JSON.stringify([overrides.allowlist ?? 'line_1']),
      60,
      12,
      500,
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      overrides.revoked ?? 0,
    );
}

function insertLegacyAudit(database: Database, id: string, grantId: string, tick: number): void {
  database
    .query(INSERT_LEGACY_AUDIT_SQL)
    .run(
      id,
      '2026-01-01T00:01:00.000Z',
      tick,
      grantId,
      'comp_metal_01',
      'set_production_target',
      `payload_${id}`,
      null,
      'SUCCESS',
      3,
    );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Every `mcp_grants` row, without assuming the retired column name. */
function grantRows(database: Database): Record<string, unknown>[] {
  return database.query<Record<string, unknown>>('SELECT rowid, * FROM mcp_grants ORDER BY rowid').all();
}

// --- secret generation and digests ------------------------------------------

test('generateMcpToken returns a prefixed 32-byte CSPRNG secret and never repeats', () => {
  const tokens = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    const token = generateMcpToken();
    assert.equal(token.startsWith(MCP_TOKEN_PREFIX), true);
    assert.equal(isWellFormedMcpToken(token), true);
    const secret = token.slice(MCP_TOKEN_PREFIX.length);
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(secret, 'base64url').length, 32);
    tokens.add(token);
  }
  assert.equal(tokens.size, 50);
});

test('hashMcpToken is a deterministic sha256 digest of the secret only', () => {
  const token = generateMcpToken();
  const digest = hashMcpToken(token);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, sha256Hex(token));
  assert.equal(hashMcpToken(token), digest);
  assert.notEqual(hashMcpToken(generateMcpToken()), digest);
  assert.equal(isTokenHash(digest), true);
  assert.equal(isTokenHash(token), false);
});

test('isWellFormedMcpToken rejects mock, demo and malformed credentials', () => {
  for (const candidate of [
    '',
    'gf_mcp_',
    'gf_mcp',
    'GF_MCP_' + 'a'.repeat(43),
    'gf_mcp_metal01_live_token',
    'gf_mcp_token_1',
    'gf_mcp_' + 'a'.repeat(42),
    'gf_mcp_' + 'a'.repeat(44),
    'gf_mcp_' + 'a'.repeat(42) + '!',
    'bearer ' + generateMcpToken(),
  ]) {
    assert.equal(isWellFormedMcpToken(candidate), false, `accepted ${JSON.stringify(candidate)}`);
  }
  assert.equal(isWellFormedMcpToken(undefined), false);
  assert.equal(isWellFormedMcpToken(42), false);
});

test('generateGrantId returns distinct opaque identifiers', () => {
  const ids = new Set(Array.from({ length: 25 }, () => generateGrantId()));
  assert.equal(ids.size, 25);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});

test('public grant metadata never carries the secret or its digest', () => {
  const policy: McpGrantPolicy = {
    grantId: 'grant_policy_1',
    playerId: 'player_1',
    companyId: 'comp_metal_01',
    matchId: 'match_test',
    phaseMode: 'PHASE_1_READ_ONLY',
    scopes: ['factory:read'],
    resourceAllowlist: ['line_1'],
    quotas: { maxReadPerMinute: 60, maxWritePerMinute: 12, maxWritePerMatch: 500 },
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    expiresAtUtc: '2026-01-02T00:00:00.000Z',
    revoked: false,
  };
  const stored: StoredMcpGrant = withTokenHash(policy, hashMcpToken(generateMcpToken()));
  const metadata = toGrantPolicy(stored);
  assert.deepEqual(metadata, policy);
  assert.deepEqual(Object.keys(metadata).sort(), Object.keys(policy).sort());
  assert.equal('token' in metadata, false);
  assert.equal('tokenHash' in metadata, false);
  assert.equal(JSON.stringify(metadata).includes(stored.tokenHash), false);
});

// --- migration 5 on a fresh database ---------------------------------------

test('migration 5 stores grant secrets under token_hash on a fresh database', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      const run = migrate(database);
      assert.deepEqual(run.appliedVersions, MIGRATIONS.map((migration) => migration.version));
      assert.equal(run.currentVersion, MIGRATIONS.at(-1)!.version);

      const columns = listColumns(database, 'mcp_grants');
      assert.equal(columns.includes('token_hash'), true);
      assert.equal(columns.includes('token'), false);
      assert.equal(grantRows(database).length, 0);
    } finally {
      closeDatabase(database);
    }
  });
});

// --- migration 5 on a populated v4 database -------------------------------

test('migration 5 retires legacy grants, scrubs secrets and preserves identity and audit links', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database, MIGRATIONS.slice(0, 4));
      assert.equal(getCurrentVersion(database), 4);
      seedCompany(database);
      insertLegacyGrant(database, 'grant_legacy_1', LEGACY_TOKENS[0]);
      insertLegacyGrant(database, 'grant_legacy_2', LEGACY_TOKENS[1], {
        revoked: 1,
        allowlist: 'line_2',
      });
      insertLegacyAudit(database, 'audit_1', 'grant_legacy_1', 5);
      insertLegacyAudit(database, 'audit_2', 'grant_legacy_1', 6);
      insertLegacyAudit(database, 'audit_3', 'grant_legacy_2', 7);
      const auditBefore = database
        .query('SELECT rowid, * FROM mcp_audit_logs ORDER BY rowid')
        .all();
      const grantsBefore = grantRows(database);

      const run = migrate(database);
      assert.deepEqual(run.appliedVersions, MIGRATIONS.filter(migration => migration.version > 4).map(migration => migration.version));
      assert.equal(getCurrentVersion(database), MIGRATIONS.at(-1)!.version);

      const columns = listColumns(database, 'mcp_grants');
      assert.equal(columns.includes('token_hash'), true);
      assert.equal(columns.includes('token'), false);

      const rows = database
        .query<Record<string, unknown>>('SELECT rowid, * FROM mcp_grants ORDER BY rowid')
        .all();
      assert.equal(rows.length, grantsBefore.length);

      const hashes = new Set<string>();
      rows.forEach((row: Record<string, unknown>, index: number) => {
        const before = grantsBefore[index];
        // Identity and metadata survive the column rename untouched.
        for (const column of [
          'grant_id',
          'player_id',
          'company_id',
          'match_id',
          'phase_mode',
          'scopes_json',
          'resource_allowlist_json',
          'max_read_per_minute',
          'max_write_per_minute',
          'max_write_per_match',
          'created_at_utc',
          'expires_at_utc',
        ]) {
          assert.equal(row[column], before[column], `${column} changed for grant ${String(row.grant_id)}`);
        }
        // Every legacy grant is revoked: no plaintext credential stays usable.
        assert.equal(row.revoked, 1);
        const tokenHash = row.token_hash;
        assert.equal(typeof tokenHash, 'string');
        assert.match(String(tokenHash), /^[0-9a-f]{64}$/);
        assert.equal(String(tokenHash), String(tokenHash).toLowerCase());
        for (const legacyToken of LEGACY_TOKENS) {
          assert.notEqual(tokenHash, legacyToken);
          assert.notEqual(tokenHash, sha256Hex(legacyToken));
        }
        hashes.add(String(tokenHash));
      });
      assert.equal(hashes.size, rows.length, 'retired placeholders must stay unique');

      assert.deepEqual(
        database.query('SELECT rowid, * FROM mcp_audit_logs ORDER BY rowid').all(),
        auditBefore,
      );
      assert.deepEqual(
        database
          .query<{ grant_id: string }>('SELECT grant_id FROM mcp_audit_logs ORDER BY rowid')
          .all()
          .map((row: { readonly grant_id: string }) => row.grant_id),
        ['grant_legacy_1', 'grant_legacy_1', 'grant_legacy_2'],
      );
    } finally {
      closeDatabase(database);
    }
  });
});

test('migration 5 is durable across close and reopen and never re-runs', () => {
  withTempDatabase((path) => {
    const first = openDatabase(path);
    let retiredRows: Record<string, unknown>[];
    try {
      migrate(first, MIGRATIONS.slice(0, 4));
      seedCompany(first);
      insertLegacyGrant(first, 'grant_legacy_1', LEGACY_TOKENS[0]);
      migrate(first);
      retiredRows = grantRows(first);
    } finally {
      closeDatabase(first);
    }

    const second = openDatabase(path);
    try {
      const run = migrate(second);
      assert.deepEqual(run.appliedVersions, []);
      assert.equal(getCurrentVersion(second), MIGRATIONS.at(-1)!.version);
      assert.deepEqual(grantRows(second), retiredRows);
      assert.equal(listColumns(second, 'mcp_grants').includes('token'), false);
    } finally {
      closeDatabase(second);
    }
  });
});

test('a failing migration 5 leaves the v4 plaintext grants untouched', () => {
  withTempDatabase((path) => {
    const database = openDatabase(path);
    try {
      migrate(database, MIGRATIONS.slice(0, 4));
      seedCompany(database);
      insertLegacyGrant(database, 'grant_legacy_1', LEGACY_TOKENS[0]);
      insertLegacyAudit(database, 'audit_1', 'grant_legacy_1', 5);
      const before = grantRows(database);
      const auditBefore = database.query('SELECT rowid, * FROM mcp_audit_logs ORDER BY rowid').all();

      const broken: Migration = {
        version: 5,
        name: 'mcp_grant_token_hash',
        sql: `${MIGRATIONS[4].sql}\nINSERT INTO table_that_does_not_exist (id) VALUES (1);`,
      };
      assert.throws(
        () => migrate(database, [...MIGRATIONS.slice(0, 4), broken]),
        /migration 5 \(mcp_grant_token_hash\) failed to apply/,
      );

      assert.equal(getCurrentVersion(database), 4);
      assert.equal(listColumns(database, 'mcp_grants').includes('token'), true);
      assert.deepEqual(grantRows(database), before);
      assert.deepEqual(
        database.query('SELECT rowid, * FROM mcp_audit_logs ORDER BY rowid').all(),
        auditBefore,
      );
    } finally {
      closeDatabase(database);
    }
  });
});
