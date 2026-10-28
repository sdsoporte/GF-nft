/**
 * Engine unit tests for pausing and resuming production lines (task T2 / spec
 * S2). These tests lock the behaviour that survived the issue #1 regression
 * fix in `src/engine/SimulatorEngine.ts`:
 *
 * - PAUSE_PRODUCTION_LINE freezes the active batch: no progress, no energy;
 * - RESUME_PRODUCTION_LINE continues the very same batch record;
 * - a line without an active batch resumes to IDLE instead of replaying a
 *   finished batch;
 * - SET_PRODUCTION_TARGET is the way to restart a paused line and it deducts
 *   the new batch's inputs before the line runs again.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompanyState, ProductionLine } from '../../src/domain/types.ts';
import {
  METAL_COMPANY,
  activeBatchOf,
  assertRejected,
  assertSucceeded,
  createEngine,
  getCompany,
  getLineByIndex,
  lastExecution,
  runTicks,
  runUntil,
  setGrid,
  setInventory,
  startProduction,
  submitCommand,
} from './core-helpers.ts';

interface Harness {
  readonly engine: ReturnType<typeof createEngine>;
  readonly company: CompanyState;
  readonly line: ProductionLine;
}

/** A single Class A line running one R1 batch from an exact stock. */
function setupR1Line(): Harness {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 10 });
  // Full storage, no generation: the only energy movements are the batch cost
  // and the documented extraction cycle at tick 10 (-15 ENERGY).
  setGrid(company, company.maxEnergyStorage, 0);
  startProduction(engine, 'lifecycle_start', METAL_COMPANY, line.lineId, 'R1', 1);
  return { engine, company, line };
}

function pause(harness: Harness, tag: string): void {
  submitCommand(harness.engine, tag, {
    type: 'PAUSE_PRODUCTION_LINE',
    companyId: METAL_COMPANY,
    lineId: harness.line.lineId,
  });
}

function resume(harness: Harness, tag: string): void {
  submitCommand(harness.engine, tag, {
    type: 'RESUME_PRODUCTION_LINE',
    companyId: METAL_COMPANY,
    lineId: harness.line.lineId,
  });
}

test('pausing a line freezes batch progress', () => {
  const harness = setupR1Line();

  runTicks(harness.engine, 3);
  assert.equal(harness.line.status, 'RUNNING');
  assert.equal(activeBatchOf(harness.line).progressTicks, 3);

  pause(harness, 'freeze');
  runTicks(harness.engine, 1);
  assert.equal(harness.line.status, 'PAUSED');
  assert.equal(activeBatchOf(harness.line).progressTicks, 3);

  runTicks(harness.engine, 6);
  assert.equal(harness.line.status, 'PAUSED');
  assert.equal(activeBatchOf(harness.line).progressTicks, 3);
  assert.equal(harness.line.totalBatchesProduced, 0);
  assert.equal(harness.company.inventory.IRON_INGOT.available, 0);
});

test('a paused line consumes no production energy', () => {
  const harness = setupR1Line();

  runTicks(harness.engine, 3);
  const energyAtPause = harness.company.energy;
  assert.equal(energyAtPause, 1000 - 3 * 2);

  pause(harness, 'no_energy_drain');
  runTicks(harness.engine, 6);
  // Ticks 4..9: only the pause command ran, no energy was spent.
  assert.equal(harness.engine.getCurrentTick(), 9);
  assert.equal(harness.company.energy, energyAtPause);

  // Tick 10 still runs the company-wide extraction cycle (-15 ENERGY), which
  // proves the engine is alive while the line itself stays frozen.
  runTicks(harness.engine, 1);
  assert.equal(harness.company.energy, energyAtPause - 15);
  assert.equal(activeBatchOf(harness.line).progressTicks, 3);
});

test('resuming a line continues the same batch and credits it on completion', () => {
  const harness = setupR1Line();

  runTicks(harness.engine, 3);
  const batchAtPause = activeBatchOf(harness.line);
  pause(harness, 'pause_then_resume');
  runTicks(harness.engine, 5);
  assert.equal(batchAtPause.progressTicks, 3);

  resume(harness, 'resume_continue');
  runTicks(harness.engine, 1);
  assert.equal(harness.line.status, 'RUNNING');
  // The pause preserved the batch record itself, not a copy or a new batch.
  assert.equal(harness.line.activeBatch, batchAtPause);
  assert.equal(batchAtPause.progressTicks, 4);

  const remainingTicks = runUntil(
    harness.engine,
    () => harness.line.totalBatchesProduced === 1,
    20,
    'resumed batch completion',
  );

  // 6 of the 10 documented ticks were still owed when the line resumed.
  assert.equal(remainingTicks, 6);
  assert.equal(harness.company.inventory.IRON_INGOT.available, 5);
  assert.equal(harness.line.status, 'IDLE');
  assert.equal(harness.line.activeBatch, null);
});

test('resuming a line without an active batch leaves it idle', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 1);

  resume(
    { engine, company, line },
    'resume_empty_line',
  );
  runTicks(engine, 1);

  assertSucceeded(lastExecution(engine));
  assert.equal(line.status, 'IDLE');
  assert.equal(line.activeBatch, null);
  assert.equal(line.totalBatchesProduced, 0);
});

test('setting a production target restarts a paused line and deducts its inputs', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, company.maxEnergyStorage, 0);

  pause({ engine, company, line }, 'pause_idle_line');
  runTicks(engine, 1);
  assert.equal(line.status, 'PAUSED');
  assert.equal(line.activeBatch, null);

  startProduction(engine, 'restart_after_pause', METAL_COMPANY, line.lineId, 'R1', 1);
  runTicks(engine, 1);

  assertSucceeded(lastExecution(engine));
  assert.equal(line.status, 'RUNNING');
  assert.equal(activeBatchOf(line).progressTicks, 1);
  assert.equal(company.inventory.RAW_ORE.available, 0);
});

test('a paused line with no batch stays paused until it is resumed', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, company.maxEnergyStorage, 0);

  pause({ engine, company, line }, 'pause_then_wait');
  runTicks(engine, 5);

  assert.equal(line.status, 'PAUSED');
  assert.equal(line.activeBatch, null);
  assert.equal(line.totalBatchesProduced, 0);
  // A paused line never starts work by itself, even with material available.
  assert.equal(company.inventory.RAW_ORE.available, 10);
  assert.equal(company.energy, 1000);

  resume({ engine, company, line }, 'resume_to_idle');
  runTicks(engine, 1);
  assert.equal(line.status, 'IDLE');
});

test('PAUSE and RESUME reject unknown lines', () => {
  const engine = createEngine();

  submitCommand(engine, 'pause_unknown', {
    type: 'PAUSE_PRODUCTION_LINE',
    companyId: METAL_COMPANY,
    lineId: 'comp_metal_01_line_99',
  });
  runTicks(engine, 1);
  assertRejected(lastExecution(engine), 'ERR_LINE_NOT_FOUND');

  submitCommand(engine, 'resume_unknown', {
    type: 'RESUME_PRODUCTION_LINE',
    companyId: METAL_COMPANY,
    lineId: 'comp_metal_01_line_99',
  });
  runTicks(engine, 1);
  assertRejected(lastExecution(engine), 'ERR_LINE_NOT_FOUND');
});
