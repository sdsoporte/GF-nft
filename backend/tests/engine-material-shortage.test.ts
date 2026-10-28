/**
 * Regression tests for GitHub issue #1:
 * `[P0][Motor] Impedir creación de recursos sin insumos al reanudar una línea`.
 *
 * The engine must never credit a batch whose inputs were not consumed.
 * When the next batch cannot start because of a material shortage, the line
 * must enter a material-wait state without retaining completed-batch progress,
 * so a later RESUME_PRODUCTION_LINE cannot replay completion for free.
 *
 * R2 (STEEL_PLATE) is used because natural extraction only replenishes
 * RAW_ORE, never IRON_INGOT, keeping the scenario deterministic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SimulatorEngine } from '../src/engine/SimulatorEngine.ts';
import type { CompanyState, ProductionLine } from '../src/domain/types.ts';

const COMPANY = 'comp_metal_01';
const LINE = 'comp_metal_01_line_1';

function setupEngineWithInputsForExactlyOneR2Batch(): SimulatorEngine {
  const engine = new SimulatorEngine();
  engine.initializeStandardMatch();
  const company = engine.getCompany(COMPANY)!;
  // Exactly one R2 batch of inputs: 4 IRON_INGOT + 5 RAW_ORE.
  company.inventory.RAW_ORE.available = 5;
  company.inventory.IRON_INGOT.available = 4;
  return engine;
}

function submitSetProductionTarget(
  engine: SimulatorEngine,
  tag: string,
): void {
  const ok = engine.submitCommand({
    commandId: `cmd_set_${tag}`,
    companyId: COMPANY,
    scheduledTick: engine.getCurrentTick() + 1,
    idempotencyKey: `idem_set_${tag}`,
    type: 'SET_PRODUCTION_TARGET',
    lineId: LINE,
    recipeId: 'R2',
    targetBatches: 3,
  });
  assert.ok(ok, 'SET_PRODUCTION_TARGET command must enqueue');
}

function submitResume(engine: SimulatorEngine, tag: string): void {
  const ok = engine.submitCommand({
    commandId: `cmd_resume_${tag}`,
    companyId: COMPANY,
    scheduledTick: engine.getCurrentTick() + 1,
    idempotencyKey: `idem_resume_${tag}`,
    type: 'RESUME_PRODUCTION_LINE',
    lineId: LINE,
  });
  assert.ok(ok, 'RESUME_PRODUCTION_LINE command must enqueue');
}

function getLine(engine: SimulatorEngine): ProductionLine {
  const company = engine.getCompany(COMPANY)!;
  const line = company.lines.find((l) => l.lineId === LINE)!;
  return line;
}

function runUntilPaused(engine: SimulatorEngine, maxTicks = 60): void {
  for (let i = 0; i < maxTicks; i += 1) {
    engine.processTick();
    if (getLine(engine).status === 'PAUSED') {
      return;
    }
  }
  assert.fail(`line never paused within ${maxTicks} ticks`);
}

test('completing the only affordable batch pauses the line with exactly one credited batch', () => {
  const engine = setupEngineWithInputsForExactlyOneR2Batch();
  submitSetProductionTarget(engine, 'initial');
  runUntilPaused(engine);

  const company = engine.getCompany(COMPANY)!;
  assert.equal(company.inventory.STEEL_PLATE.available, 4);
  assert.equal(getLine(engine).totalBatchesProduced, 1);
  // Inputs for the first batch were consumed; no free inputs remain.
  assert.equal(company.inventory.IRON_INGOT.available, 0);
});

test('resuming after a material shortage never credits another batch', () => {
  const engine = setupEngineWithInputsForExactlyOneR2Batch();
  submitSetProductionTarget(engine, 'initial');
  runUntilPaused(engine);

  const company = engine.getCompany(COMPANY)!;
  assert.equal(company.inventory.STEEL_PLATE.available, 4);

  // Resume without restocking materials, then advance ticks.
  submitResume(engine, 'after_shortage');
  for (let i = 0; i < 5; i += 1) {
    engine.processTick();
  }

  // No batch may complete without consuming its inputs.
  assert.equal(company.inventory.STEEL_PLATE.available, 4);
  assert.equal(getLine(engine).totalBatchesProduced, 1);
});

test('material shortage leaves no stale active batch to replay', () => {
  const engine = setupEngineWithInputsForExactlyOneR2Batch();
  submitSetProductionTarget(engine, 'initial');
  runUntilPaused(engine);

  const line = getLine(engine);
  // The completed batch was already credited; the next batch never started
  // because its inputs could not be deducted. Nothing may remain active.
  assert.equal(line.activeBatch, null);

  // Resuming a line without an active batch yields IDLE, not a phantom run.
  submitResume(engine, 'no_batch');
  engine.processTick();
  assert.equal(getLine(engine).status, 'IDLE');
});

test('restarting production without sufficient inputs is rejected', () => {
  const engine = setupEngineWithInputsForExactlyOneR2Batch();
  submitSetProductionTarget(engine, 'initial');
  runUntilPaused(engine);

  submitSetProductionTarget(engine, 'restart_no_inputs');
  engine.processTick(); // Commands execute at their scheduled tick.
  const last = engine.getExecutionHistory().at(-1)!;
  assert.equal(last.success, false);
  assert.equal(last.errorCode, 'ERR_INSUFFICIENT_INVENTORY');

  const company = engine.getCompany(COMPANY)!;
  assert.equal(company.inventory.STEEL_PLATE.available, 4);
  assert.equal(getLine(engine).activeBatch, null);
});
