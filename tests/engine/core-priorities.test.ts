/**
 * Engine unit tests for production line priorities (task T2 / spec S2).
 *
 * Documented behavior: every tick the grid generates energy and the engine
 * distributes it "strictly by priority" (SimulatorEngine.processTick step 3).
 * Lines are served from priority 1 upwards, ties are broken by `lineId`, and a
 * line that cannot pay its per-tick energy cost starves with status
 * `NO_ENERGY` instead of advancing.
 *
 * All scenarios use R1 on Class A (10 ticks, 20 ENERGY per batch, paid as
 * 2 ENERGY per tick) with a deliberately small generation so one line can run
 * and the other cannot. Starting energy is 0 and the grid never reaches the
 * 15 ENERGY the extraction cycle needs, so no material is created mid-test.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompanyState, ProductionLine } from '../../src/domain/types.ts';
import {
  METAL_COMPANY,
  activeBatchOf,
  assertRejected,
  createEngine,
  getCompany,
  getLineByIndex,
  lastExecution,
  runTicks,
  setGrid,
  setInventory,
  startProduction,
  submitCommand,
} from './core-helpers.ts';

interface LineHarness {
  readonly engine: ReturnType<typeof createEngine>;
  readonly company: CompanyState;
  readonly lines: readonly ProductionLine[];
  readonly first: ProductionLine;
  readonly second: ProductionLine;
  readonly third: ProductionLine;
}

interface HarnessOptions {
  readonly lineCount: number;
  readonly rawOre: number;
  readonly energy: number;
  readonly generationPerTick: number;
  readonly targetBatches: number;
  readonly tag: string;
}

/** Start one R1 batch on each of the first `lineCount` lines of the Class A company. */
function setupR1Lines(options: HarnessOptions): LineHarness {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setInventory(company, { RAW_ORE: options.rawOre });
  setGrid(company, options.energy, options.generationPerTick);

  for (let index = 0; index < options.lineCount; index += 1) {
    const line = getLineByIndex(engine, METAL_COMPANY, index);
    startProduction(
      engine,
      `${options.tag}_${index}`,
      METAL_COMPANY,
      line.lineId,
      'R1',
      options.targetBatches,
    );
  }

  return {
    engine,
    company,
    lines: company.lines,
    first: getLineByIndex(engine, METAL_COMPANY, 0),
    second: getLineByIndex(engine, METAL_COMPANY, 1),
    third: getLineByIndex(engine, METAL_COMPANY, 2),
  };
}

test('priority 1 claims scarce energy before priority 2', () => {
  const harness = setupR1Lines({
    lineCount: 2,
    rawOre: 20,
    energy: 0,
    generationPerTick: 2,
    targetBatches: 1,
    tag: 'scarce',
  });

  runTicks(harness.engine, 9);

  assert.equal(harness.first.priority, 1);
  assert.equal(harness.second.priority, 2);
  assert.equal(harness.first.status, 'RUNNING');
  assert.equal(activeBatchOf(harness.first).progressTicks, 9);
  assert.equal(harness.second.status, 'NO_ENERGY');
  assert.equal(activeBatchOf(harness.second).progressTicks, 0);
  // Only the served line spent energy; the starved line consumed nothing.
  assert.equal(harness.company.energy, 0);
  assert.equal(harness.company.inventory.RAW_ORE.available, 0);
});

test('the priority 1 line completes while the priority 2 line stays starved', () => {
  const harness = setupR1Lines({
    lineCount: 2,
    rawOre: 20,
    energy: 0,
    generationPerTick: 2,
    targetBatches: 1,
    tag: 'completion',
  });

  runTicks(harness.engine, 10);

  assert.equal(harness.first.totalBatchesProduced, 1);
  assert.equal(harness.first.status, 'IDLE');
  assert.equal(harness.company.inventory.IRON_INGOT.available, 5);
  assert.equal(harness.second.totalBatchesProduced, 0);
  assert.equal(harness.second.status, 'NO_ENERGY');
  assert.equal(activeBatchOf(harness.second).progressTicks, 0);
});

test('a priority change redirects energy to the promoted line', () => {
  const harness = setupR1Lines({
    lineCount: 2,
    rawOre: 60,
    energy: 0,
    generationPerTick: 2,
    targetBatches: 3,
    tag: 'redirect',
  });

  // After 10 ticks the first line finished one batch and started the next one.
  runTicks(harness.engine, 10);
  assert.equal(harness.first.totalBatchesProduced, 1);
  assert.equal(activeBatchOf(harness.first).progressTicks, 0);
  assert.equal(activeBatchOf(harness.second).progressTicks, 0);

  // Both commands land on the same tick, so the swap applies before that
  // tick's energy distribution.
  const swapTick = harness.engine.getCurrentTick() + 1;
  submitCommand(
    harness.engine,
    'promote_second',
    { type: 'SET_LINE_PRIORITY', companyId: METAL_COMPANY, lineId: harness.second.lineId, priority: 1 },
    swapTick,
  );
  submitCommand(
    harness.engine,
    'demote_first',
    { type: 'SET_LINE_PRIORITY', companyId: METAL_COMPANY, lineId: harness.first.lineId, priority: 3 },
    swapTick,
  );

  runTicks(harness.engine, 5);

  assert.equal(harness.second.priority, 1);
  assert.equal(harness.first.priority, 3);
  assert.equal(harness.second.status, 'RUNNING');
  assert.equal(activeBatchOf(harness.second).progressTicks, 5);
  assert.equal(harness.first.status, 'NO_ENERGY');
  assert.equal(activeBatchOf(harness.first).progressTicks, 0);
  assert.equal(harness.first.totalBatchesProduced, 1);
});

test('equal priorities are ordered by line id', () => {
  const harness = setupR1Lines({
    lineCount: 2,
    rawOre: 20,
    energy: 0,
    generationPerTick: 2,
    targetBatches: 1,
    tag: 'tie',
  });

  // Make both lines priority 1 on the first tick.
  submitCommand(harness.engine, 'tie_second', {
    type: 'SET_LINE_PRIORITY',
    companyId: METAL_COMPANY,
    lineId: harness.second.lineId,
    priority: 1,
  });

  runTicks(harness.engine, 5);

  assert.equal(harness.first.priority, 1);
  assert.equal(harness.second.priority, 1);
  // `comp_metal_01_line_1` sorts before `comp_metal_01_line_2`.
  assert.equal(activeBatchOf(harness.first).progressTicks, 5);
  assert.equal(harness.first.status, 'RUNNING');
  assert.equal(activeBatchOf(harness.second).progressTicks, 0);
  assert.equal(harness.second.status, 'NO_ENERGY');
});

test('three lines are served in priority order from 1 downwards', () => {
  const harness = setupR1Lines({
    lineCount: 3,
    rawOre: 30,
    energy: 0,
    generationPerTick: 4,
    targetBatches: 1,
    tag: 'three',
  });

  // Invert the default order: line_3 first, line_2 second, line_1 last.
  const firstTick = harness.engine.getCurrentTick() + 1;
  submitCommand(
    harness.engine,
    'three_line3',
    { type: 'SET_LINE_PRIORITY', companyId: METAL_COMPANY, lineId: harness.third.lineId, priority: 1 },
    firstTick,
  );
  submitCommand(
    harness.engine,
    'three_line1',
    { type: 'SET_LINE_PRIORITY', companyId: METAL_COMPANY, lineId: harness.first.lineId, priority: 3 },
    firstTick,
  );

  // 4 ENERGY per tick pays exactly two 2-ENERGY lines.
  runTicks(harness.engine, 5);

  assert.equal(harness.third.status, 'RUNNING');
  assert.equal(activeBatchOf(harness.third).progressTicks, 5);
  assert.equal(harness.second.status, 'RUNNING');
  assert.equal(activeBatchOf(harness.second).progressTicks, 5);
  assert.equal(harness.first.status, 'NO_ENERGY');
  assert.equal(activeBatchOf(harness.first).progressTicks, 0);
});

test('a starved line recovers as soon as the grid has spare energy', () => {
  const harness = setupR1Lines({
    lineCount: 2,
    rawOre: 20,
    energy: 0,
    generationPerTick: 2,
    targetBatches: 1,
    tag: 'recovery',
  });

  runTicks(harness.engine, 3);
  assert.equal(harness.second.status, 'NO_ENERGY');
  assert.equal(activeBatchOf(harness.first).progressTicks, 3);
  assert.equal(activeBatchOf(harness.second).progressTicks, 0);

  harness.company.energyGenerationPerTick = 100;
  runTicks(harness.engine, 1);

  assert.equal(harness.first.status, 'RUNNING');
  assert.equal(harness.second.status, 'RUNNING');
  assert.equal(activeBatchOf(harness.first).progressTicks, 4);
  assert.equal(activeBatchOf(harness.second).progressTicks, 1);
});

test('a priority command applies on its scheduled tick, not at submit time', () => {
  const harness = setupR1Lines({
    lineCount: 2,
    rawOre: 20,
    energy: 0,
    generationPerTick: 2,
    targetBatches: 1,
    tag: 'scheduled',
  });

  const scheduledTick = harness.engine.getCurrentTick() + 3;
  submitCommand(
    harness.engine,
    'late_promote',
    { type: 'SET_LINE_PRIORITY', companyId: METAL_COMPANY, lineId: harness.second.lineId, priority: 1 },
    scheduledTick,
  );
  submitCommand(
    harness.engine,
    'late_demote',
    { type: 'SET_LINE_PRIORITY', companyId: METAL_COMPANY, lineId: harness.first.lineId, priority: 3 },
    scheduledTick,
  );

  runTicks(harness.engine, 2);
  assert.equal(harness.first.priority, 1);
  assert.equal(harness.second.priority, 2);
  assert.equal(activeBatchOf(harness.first).progressTicks, 2);
  assert.equal(activeBatchOf(harness.second).progressTicks, 0);

  runTicks(harness.engine, 1);
  assert.equal(harness.engine.getCurrentTick(), scheduledTick);
  assert.equal(harness.first.priority, 3);
  assert.equal(harness.second.priority, 1);
  assert.equal(activeBatchOf(harness.second).progressTicks, 1);
  assert.equal(harness.second.status, 'RUNNING');
  assert.equal(harness.first.status, 'NO_ENERGY');
});

test('SET_LINE_PRIORITY rejects an unknown line and leaves priorities untouched', () => {
  const harness = setupR1Lines({
    lineCount: 2,
    rawOre: 20,
    energy: 0,
    generationPerTick: 2,
    targetBatches: 1,
    tag: 'unknown_line',
  });

  submitCommand(harness.engine, 'bad_line', {
    type: 'SET_LINE_PRIORITY',
    companyId: METAL_COMPANY,
    lineId: 'comp_metal_01_line_99',
    priority: 1,
  });
  runTicks(harness.engine, 1);

  assertRejected(lastExecution(harness.engine), 'ERR_LINE_NOT_FOUND');
  assert.deepEqual(
    harness.lines.map((line) => line.priority),
    [1, 2, 3],
  );
});
