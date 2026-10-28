import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactoryMatch } from '../src/match.ts';
import { MatchStore, createMatchStore, type CommitCommandInput } from '../src/persistence/matchStore.ts';
import { openDatabase, closeDatabase } from '../src/persistence/database.ts';
import { migrate } from '../src/persistence/migrations.ts';

// Public store injection models a transaction failure after its engine apply.
class FailingAdmissionStore extends MatchStore {
  override commitCommand(input: CommitCommandInput): void {
    super.commitCommand({ ...input, apply: () => {
      assert.equal(input.apply(), true);
      throw new Error('synthetic admission failure');
    } });
  }
}

test('failed durable MCP admission leaves simulation, queue, dedupe, sequence and recovered state unchanged', () => {
  const database = openDatabase(':memory:');
  try {
    migrate(database);
    const match = new FactoryMatch({ store: new FailingAdmissionStore(database) });
    const before = match.engine.createSnapshot();
    const queue = match.engine.getCommandQueue();
    const sequence = queue.getSequenceCounter();
    assert.throws(() => match.submitMcpCommand({ commandId: 'input_id_not_trusted',
      companyId: 'comp_metal_01', scheduledTick: 999, idempotencyKey: 'idem_rollback_mcp',
      type: 'PAUSE_PRODUCTION_LINE', lineId: 'comp_metal_01_line_1' }), /synthetic admission failure/);
    assert.deepEqual(match.engine.createSnapshot(), before);
    assert.equal(queue.getPendingCount(), 0);
    assert.equal(queue.getProcessedIdempotencyKeyCount(), 0);
    assert.equal(queue.getSequenceCounter(), sequence);
    assert.equal(match.getAcknowledgedRequestCount(), 0);
    const restored = new FactoryMatch({ store: createMatchStore(database) });
    assert.deepEqual(restored.engine.createSnapshot(), before);
    assert.equal(restored.engine.getCommandQueue().getPendingCount(), 0);
    assert.equal(restored.engine.getCommandQueue().getProcessedIdempotencyKeyCount(), 0);
    assert.equal(restored.engine.getCommandQueue().getSequenceCounter(), sequence);
    assert.equal(restored.getAcknowledgedRequestCount(), 0);
  } finally { closeDatabase(database); }
});
