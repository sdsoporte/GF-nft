import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Database } from 'bun:sqlite';
import { FactoryMatch } from '../../../src/match.ts';
import { MatchStore } from '../../../src/persistence/matchStore.ts';
import { migrate } from '../../../src/persistence/migrations.ts';
import { ReplaySnapshotRepository } from '../../../src/persistence/repos/replaySnapshots.ts';

describe('Durable Replay Restart and Snapshot Persistence (issue #11)', () => {
  it('persists and retrieves snapshots with cryptographic checksums via ReplaySnapshotRepository', () => {
    const db = new Database(':memory:');
    migrate(db);

    const repo = new ReplaySnapshotRepository(db);

    repo.saveSnapshot({
      snapshotId: 'snap_match1_tick100',
      matchId: 'match_test_1',
      tick: 100,
      checksumSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      stateHash: '12345678',
      stateJson: JSON.stringify({ tick: 100, state: 'ok' }),
    });

    const retrieved = repo.getSnapshot('match_test_1', 100);
    assert.ok(retrieved !== null);
    assert.equal(retrieved.snapshotId, 'snap_match1_tick100');
    assert.equal(retrieved.tick, 100);
    assert.equal(retrieved.stateHash, '12345678');
    assert.equal(
      retrieved.checksumSha256,
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
    );

    const list = repo.listSnapshots('match_test_1');
    assert.equal(list.length, 1);

    const latest = repo.getLatestSnapshot('match_test_1');
    assert.equal(latest?.snapshotId, 'snap_match1_tick100');
  });

  it('retains command history and idempotency across backend restart without data loss', () => {
    const db = new Database(':memory:');
    migrate(db);

    const matchId = 'match_restart_test';
    const store = new MatchStore(db);

    // Instance 1
    const match1 = new FactoryMatch({
      store,
      matchId,
      seed: 54321,
    });

    // Submit a command through match1
    const decision = match1.requestProduction({
      requestId: 'req_001',
      lineId: 'comp_metal_01_line_1',
      recipeId: 'R1',
    });
    assert.equal(decision.kind, 'queued');
    assert.ok(decision.commandId !== undefined);

    // Also submit an MCP command with explicit idempotency key
    const mcpSubmitted = match1.submitMcpCommand({
      type: 'SET_PRODUCTION_TARGET',
      commandId: 'cmd_mcp_test_01',
      companyId: 'comp_metal_01',
      scheduledTick: 1,
      idempotencyKey: 'permanent_mcp_key_123',
      lineId: 'comp_metal_01_line_2',
      recipeId: 'R1',
      targetBatches: 1,
    });
    assert.equal(mcpSubmitted, true);

    // Advance 10 ticks so commands execute completely
    match1.advanceTicks(10);

    const statusView1 = match1.getCommandStatus(decision.commandId);
    assert.equal(statusView1?.status, 'executed');

    // Simulate backend restart: create Instance 2 with the same store & matchId
    const match2 = new FactoryMatch({
      store,
      matchId,
      seed: 54321,
    });

    // 1. History is retained across restart
    const statusView2 = match2.getCommandStatus(decision.commandId);
    assert.equal(statusView2?.status, 'executed');

    // 2. HTTP Request idempotency is retained: repeating identical request returns original commandId
    const idempotentDecision = match2.requestProduction({
      requestId: 'req_001',
      lineId: 'comp_metal_01_line_1',
      recipeId: 'R1',
    });
    assert.equal(idempotentDecision.kind, 'queued');
    if (idempotentDecision.kind === 'queued') {
      assert.equal(idempotentDecision.commandId, decision.commandId);
    }

    // 3. Request ID reuse with conflicting payload is rejected
    const reusedMismatchDecision = match2.requestProduction({
      requestId: 'req_001',
      lineId: 'comp_metal_01_line_2', // Different line
      recipeId: 'R1',
    });
    assert.equal(reusedMismatchDecision.kind, 'request_id_reused');

    // 4. Command idempotency key deduplication is retained in engine queue across restart
    const duplicateMcp = match2.submitMcpCommand({
      type: 'SET_PRODUCTION_TARGET',
      commandId: 'cmd_mcp_test_duplicate',
      companyId: 'comp_metal_01',
      scheduledTick: 11,
      idempotencyKey: 'permanent_mcp_key_123', // Already used
      lineId: 'comp_metal_01_line_2',
      recipeId: 'R1',
      targetBatches: 1,
    });
    assert.equal(duplicateMcp, false);
  });
});
