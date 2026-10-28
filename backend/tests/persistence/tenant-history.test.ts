import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactoryMatch } from '../../src/match.ts';
import { McpGateway } from '../../src/mcp/McpGateway.ts';
import { openDatabase, closeDatabase } from '../../src/persistence/database.ts';
import { createMatchStore } from '../../src/persistence/matchStore.ts';
import { MIGRATIONS, migrate, MigrationError, getCurrentVersion, getAppliedMigrations } from '../../src/persistence/migrations.ts';
import { createRepositories } from '../../src/persistence/repos/index.ts';
import { sampleMetadata } from './queue-fixtures.ts';
import { createGatewayFixture, expectSuccess, makeGrant, TENANT_A, TENANT_B, LINE_A1, LINE_B1 } from '../mcp/grant-helper.ts';

test('tenant history survives a database close/reopen and match recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gf-tenant-history-'));
  const path = join(directory, 'match.db');
  let database = openDatabase(path);
  try {
    migrate(database);
    const match = new FactoryMatch({ store: createMatchStore(database) });
    for (const [companyId, lineId] of [[TENANT_A, LINE_A1], [TENANT_B, LINE_B1]]) {
      match.engine.submitCommand({ commandId: `cmd_${companyId}`, idempotencyKey: `idem_${companyId}`, companyId, scheduledTick: 1, type: 'PAUSE_PRODUCTION_LINE', lineId });
    }
    match.advanceTicks();
    const before = match.engine.getExecutionHistory();
    assert.deepEqual(before.map(result => result.companyId), [TENANT_A, TENANT_B]);
    const matchId = match.matchId;
    closeDatabase(database);
    database = openDatabase(path);
    migrate(database);
    const restored = new FactoryMatch({ store: createMatchStore(database) });
    assert.equal(restored.matchId, matchId);
    assert.deepEqual(restored.engine.getExecutionHistory(), before);
    assert.deepEqual(restored.engine.getCompanyExecutionHistory(TENANT_A), [before[0]]);
    const grant = { ...makeGrant(), matchId };
    const gateway = new McpGateway(restored.engine, { matchId, companyPlayers: { [TENANT_A]: `player_${TENANT_A}` } });
    gateway.registerGrant(grant);
    const response = expectSuccess(await gateway.invokeTool(grant.token, 'get_action_history', { company_id: TENANT_A }));
    assert.deepEqual((response.data as { history: Array<{ command_id: string }> }).history.map(result => result.command_id), [`cmd_${TENANT_A}`]);
  } finally {
    closeDatabase(database);
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const induceFailure of [false, true]) {
  test(`legacy v3 history is retained without invented ownership${induceFailure ? ' after a rolled-back migration' : ''}`, async () => {
    const database = openDatabase(':memory:');
    try {
      migrate(database, MIGRATIONS.slice(0, 3));
      const repositories = createRepositories(database);
      const metadata = sampleMetadata({ currentTick: 1, historyCursor: 1 });
      repositories.matches.save(metadata);
      // Setup only: this is the documented v3 format, before company_id existed.
      // Assertions below use repository/migrator/engine/gateway public APIs.
      database.query('INSERT INTO match_command_results (match_id, history_index, command_id, idempotency_key, executed_at_tick, success) VALUES (?, ?, ?, ?, ?, ?)').run(metadata.matchId, 0, 'cmd_legacy', 'idem_legacy', 1, 1);
      const savedMetadata = repositories.matches.load(metadata.matchId);
      if (induceFailure) {
        assert.throws(() => migrate(database, [...MIGRATIONS.slice(0, 3), { version: 4, name: 'broken_tenant_history', sql: 'ALTER TABLE match_command_results ADD COLUMN company_id TEXT; INVALID SQL;' }]), MigrationError);
        assert.equal(getCurrentVersion(database), 3);
        assert.deepEqual(getAppliedMigrations(database).map(item => item.version), [1, 2, 3]);
        assert.deepEqual(repositories.matches.load(metadata.matchId), savedMetadata);
      }
      migrate(database);
      assert.equal(getCurrentVersion(database), MIGRATIONS.at(-1)!.version);
      const results = repositories.commandResults.list(metadata.matchId);
      assert.deepEqual(results, [{ matchId: metadata.matchId, historyIndex: 0, commandId: 'cmd_legacy', idempotencyKey: 'idem_legacy', executedAtTick: 1, success: true }]);
      assert.equal(repositories.commandResults.count(metadata.matchId), 1);
      assert.deepEqual(repositories.matches.load(metadata.matchId), savedMetadata);
      const grant = makeGrant();
      const { engine, gateway } = createGatewayFixture([grant]);
      engine.hydrate({ currentTick: 1, commandResults: results.map(({ matchId, historyIndex, ...result }) => result) });
      const response = expectSuccess(await gateway.invokeTool(grant.token, 'get_action_history', { company_id: TENANT_A }));
      assert.deepEqual(response.data, { history: [] });
      assert.equal(engine.getExecutionHistory().length, 1);
      assert.deepEqual(engine.getCompanyExecutionHistory(TENANT_A), []);
    } finally { closeDatabase(database); }
  });
}

test('invalid tenant attribution rejects an entire append without changing history', () => {
  const database = openDatabase(':memory:');
  try {
    migrate(database);
    const repositories = createRepositories(database);
    const metadata = sampleMetadata();
    repositories.matches.save(metadata);
    const before = repositories.commandResults.list(metadata.matchId);
    const result = { matchId: metadata.matchId, historyIndex: 0, commandId: 'cmd_append', idempotencyKey: 'idem_append', executedAtTick: 1, success: true, companyId: TENANT_A };
    assert.throws(() => repositories.commandResults.appendMany([result, { ...result, historyIndex: 1, commandId: 'cmd_bad', companyId: '' }]), /companyId/);
    assert.deepEqual(repositories.commandResults.list(metadata.matchId), before);
    assert.equal(repositories.commandResults.count(metadata.matchId), 0);
  } finally { closeDatabase(database); }
});
