/**
 * Mid-match restart recovery (S5) and full-state comparison (S9).
 *
 * What the spec asks for (issue #8):
 * - S5: "Reiniciar el backend a mitad de una partida y reconstruir el estado
 *   exactamente" — drive a match to a mid-game tick, close the process, reopen
 *   the same database and byte-compare the reconstructed state;
 * - S9: "Test de recuperación compara hashes/estado completo antes y después" —
 *   the comparison covers the full state (A4) and fails on any divergence; the
 *   partial `calculateStateHash()` is never the sole oracle.
 *
 * The scenario lives in `recovery-fixtures.ts` (public match API plus the store
 * seam for contract traffic) and the comparable state in `recovery-oracle.ts`,
 * which documents what is included and what is excluded. No listener, no port,
 * no timer: `advanceTicks()` is this backend's injected clock, so every tick is
 * explicit and reproducible.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_MATCH_SEED, FactoryMatch } from '../../src/match.ts';
import { closeDatabase } from '../../src/persistence/database.ts';
import { openPersistedStore, MATCH_ID, withTempDirectory } from './queue-fixtures.ts';
import { MID_GAME_TICK, driveMidGame, type MidGameScript } from './recovery-fixtures.ts';
import {
  buildRecoveryOracle,
  canonicalJson,
  type RecoveryOracleOptions,
} from './recovery-oracle.ts';

/** Every assertion below pins the state the comparison is supposed to cover. */
function assertMidGameIsMeaningful(match: FactoryMatch): void {
  const snapshot = match.engine.createSnapshot();
  assert.equal(snapshot.tick, MID_GAME_TICK);
  assert.equal(match.engine.getCommandQueue().getPendingCount(), 1, 'one command stays pending');

  const companies = Object.values(snapshot.companies);
  assert.equal(companies.length, 4);
  assert.ok(
    companies.some((company) => company.lines.some((line) => line.activeBatch !== null)),
    'some line must be mid-batch at the mid-game tick',
  );
  assert.ok(
    companies.some((company) => company.maintenancePaidTicks > 0),
    'maintenance must have been charged',
  );

  const contracts = Object.values(snapshot.contracts);
  assert.equal(contracts.length, 2);
  const defaulted = contracts.find((contract) => contract.status === 'DEFAULTED');
  const active = contracts.find((contract) => contract.status === 'ACTIVE');
  assert.ok(defaulted, 'the expiring offer must be DEFAULTED');
  assert.equal(defaulted.settledAtTick, 41);
  assert.ok(active, 'the accepted offer must still be ACTIVE');
  assert.equal(active.deliveredQuantity, 0);

  const history = match.engine.getExecutionHistory();
  assert.ok(history.some((result) => result.success), 'some command must have executed');
  assert.ok(history.some((result) => !result.success), 'some command must have been rejected');
  assert.equal(snapshot.globalProject.deliveredMegamachineParts, 0);
  assert.ok(
    match.engine.getCommandQueue().listProcessedIdempotencyKeys().length >= 5,
    'every admitted command must leave a permanent idempotency key',
  );
}

/** Fresh match + script + comparable state, on one database file. */
function driveAndCapture(
  path: string,
  options: RecoveryOracleOptions = {},
): { state: string; script: MidGameScript } {
  const persistence = openPersistedStore(path);
  try {
    const match = new FactoryMatch({
      store: persistence.store,
      matchId: MATCH_ID,
      seed: DEFAULT_MATCH_SEED,
      tickIntervalMs: 250,
    });
    const script = driveMidGame(match, persistence.store);
    assertMidGameIsMeaningful(match);
    return {
      state: canonicalJson(
        buildRecoveryOracle(match, persistence.store, script.notifiedCommandIds, options),
      ),
      script,
    };
  } finally {
    closeDatabase(persistence.database);
  }
}

test('S5: a mid-game restart reconstructs byte-identical engine and match state', () => {
  withTempDirectory((directory) => {
    const path = join(directory, 'factory.db');
    const { state: before, script } = driveAndCapture(path);

    const second = openPersistedStore(path);
    try {
      const revived = new FactoryMatch({ store: second.store });
      // Adoption, not a new match: identity and clock cadence come from the row.
      assert.equal(revived.matchId, MATCH_ID);
      assert.equal(revived.tickIntervalMs, 250);
      // Every acknowledgement row folds back into the live ledger on a restore,
      // including the harness seam rows the pre-close match could not see.
      assert.equal(
        revived.getAcknowledgedRequestCount(),
        second.store.repositories.ackLedger.count(MATCH_ID),
      );

      const after = buildRecoveryOracle(revived, second.store, script.notifiedCommandIds);
      // deepEqual first: its diff names the diverging field. The canonical byte
      // comparison after it is the S5/S9 "identical state" assertion.
      assert.deepEqual(after, JSON.parse(before));
      assert.equal(canonicalJson(after), before);

      // A6, engine-side store (S8): the permanent idempotency keys are restored,
      // so the engine's own dedupe guard is armed before the clock starts.
      const queue = revived.engine.getCommandQueue();
      for (const key of queue.listProcessedIdempotencyKeys()) {
        assert.equal(queue.isIdempotencyKeyUsed(key), true, `key ${key} was not restored`);
      }
      assert.equal(queue.listProcessedIdempotencyKeys().length >= 5, true);
    } finally {
      closeDatabase(second.database);
    }
  });
});

test('S9: the same seed and script produce identical state on two independent databases', () => {
  withTempDirectory((directory) => {
    const alpha = driveAndCapture(join(directory, 'alpha.db'), { relabelCommandIds: true });
    const beta = driveAndCapture(join(directory, 'beta.db'), { relabelCommandIds: true });
    assert.equal(alpha.state, beta.state);
  });
});

test('S9: a hydrated match keeps evolving exactly like a match that never restarted', () => {
  withTempDirectory((directory) => {
    const restartedPath = join(directory, 'restarted.db');
    const controlPath = join(directory, 'control.db');
    const { script } = driveAndCapture(restartedPath);

    // Control: the same script on an untouched database, then the same extra
    // ticks. The command still pending at the mid-game tick executes at 315.
    const control = openPersistedStore(controlPath);
    let controlState: string;
    try {
      const match = new FactoryMatch({
        store: control.store,
        matchId: MATCH_ID,
        seed: DEFAULT_MATCH_SEED,
        tickIntervalMs: 250,
      });
      const controlScript = driveMidGame(match, control.store);
      match.advanceTicks(40);
      controlState = canonicalJson(
        buildRecoveryOracle(match, control.store, controlScript.notifiedCommandIds, {
          relabelCommandIds: true,
        }),
      );
    } finally {
      closeDatabase(control.database);
    }

    const second = openPersistedStore(restartedPath);
    try {
      const revived = new FactoryMatch({ store: second.store });
      assert.equal(
        revived.engine.getCommandQueue().getPendingCount(),
        1,
        'the interrupted queue must be restored, not dropped',
      );

      revived.advanceTicks(40);
      const revivedState = buildRecoveryOracle(revived, second.store, script.notifiedCommandIds, {
        relabelCommandIds: true,
      });
      assert.equal(canonicalJson(revivedState), controlState);

      assert.equal(revived.engine.getCommandQueue().getPendingCount(), 0);
      for (const commandId of script.notifiedCommandIds) {
        const status = revived.getCommandStatus(commandId);
        assert.ok(status, `command ${commandId} must keep a status after the restart`);
        assert.notEqual(status.status, 'queued', 'every driven command must have executed');
      }
    } finally {
      closeDatabase(second.database);
    }
  });
});
