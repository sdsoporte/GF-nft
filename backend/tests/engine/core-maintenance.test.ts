/**
 * Engine unit tests for periodic maintenance (task T2 / spec S2).
 *
 * Documented rule (GAME_DESIGN_MVP.md §4.1): "Cada 300 ticks (5 minutos), cada
 * línea activa consume 100 CREDITS de mantenimiento operativo". The engine
 * counts RUNNING and NO_ENERGY lines as active, charges after the tick's
 * production phase, and reacts to a shortfall by emptying the credits, pausing
 * the running lines and taking 5 reputation points.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { CompanyState, ProductionLine } from '../../src/domain/types.ts';
import {
  IDLE_COMPANY,
  METAL_COMPANY,
  activeBatchOf,
  createEngine,
  getCompany,
  getLineByIndex,
  runTicks,
  setGrid,
  setInventory,
  startProduction,
  submitCommand,
} from './core-helpers.ts';

const MAINTENANCE_INTERVAL = 300;
const MAINTENANCE_COST = 100;
const STARTING_CREDITS = 10000;

interface Harness {
  readonly engine: ReturnType<typeof createEngine>;
  readonly company: CompanyState;
  readonly lines: readonly ProductionLine[];
}

interface HarnessOptions {
  readonly lineCount: number;
  readonly rawOre?: number;
  readonly targetBatches?: number;
  readonly energy?: number;
  readonly energyPerTick?: number;
  readonly tag: string;
}

/** Start long R1 batches so the given lines are still active at tick 300. */
function setupRunningLines(options: HarnessOptions): Harness {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setInventory(company, { RAW_ORE: options.rawOre ?? 2000 });
  // R1 on Class A lasts 10 ticks, so 100 batches keep a line busy far past 300.
  for (let index = 0; index < options.lineCount; index += 1) {
    const line = getLineByIndex(engine, METAL_COMPANY, index);
    startProduction(
      engine,
      `${options.tag}_${index}`,
      METAL_COMPANY,
      line.lineId,
      'R1',
      options.targetBatches ?? 100,
    );
  }
  if (options.energy !== undefined && options.energyPerTick !== undefined) {
    setGrid(company, options.energy, options.energyPerTick);
  }
  return { engine, company, lines: company.lines };
}

test('maintenance charges 100 CREDITS per active line at tick 300', () => {
  const harness = setupRunningLines({ lineCount: 2, tag: 'two_lines' });

  runTicks(harness.engine, MAINTENANCE_INTERVAL - 1);
  assert.equal(harness.engine.getCurrentTick(), 299);
  assert.equal(harness.company.credits, STARTING_CREDITS);
  assert.equal(harness.company.maintenancePaidTicks, 0);
  assert.equal(harness.lines[0].status, 'RUNNING');
  assert.equal(harness.lines[1].status, 'RUNNING');

  runTicks(harness.engine, 1);
  assert.equal(harness.engine.getCurrentTick(), 300);
  assert.equal(harness.company.credits, STARTING_CREDITS - 2 * MAINTENANCE_COST);
  assert.equal(harness.company.maintenancePaidTicks, 1);
});

test('maintenance repeats every 300 ticks', () => {
  const harness = setupRunningLines({ lineCount: 2, tag: 'repeat' });

  runTicks(harness.engine, MAINTENANCE_INTERVAL);
  assert.equal(harness.company.credits, STARTING_CREDITS - 2 * MAINTENANCE_COST);

  runTicks(harness.engine, MAINTENANCE_INTERVAL);
  assert.equal(harness.engine.getCurrentTick(), 600);
  assert.equal(harness.company.credits, STARTING_CREDITS - 4 * MAINTENANCE_COST);
  assert.equal(harness.company.maintenancePaidTicks, 2);
});

test('companies with no active line pay no maintenance', () => {
  const engine = createEngine();
  const company = getCompany(engine, IDLE_COMPANY);

  runTicks(engine, 2 * MAINTENANCE_INTERVAL);

  assert.equal(engine.getCurrentTick(), 600);
  assert.equal(company.credits, STARTING_CREDITS);
  assert.equal(company.reputation, 100);
  assert.equal(company.lines.every((line) => line.status === 'IDLE'), true);
});

test('paused lines are not charged as active', () => {
  const harness = setupRunningLines({ lineCount: 2, tag: 'paused' });

  // Pause the second line on the first tick, before maintenance is collected.
  submitCommand(harness.engine, 'pause_second', {
    type: 'PAUSE_PRODUCTION_LINE',
    companyId: METAL_COMPANY,
    lineId: harness.lines[1].lineId,
  });
  runTicks(harness.engine, MAINTENANCE_INTERVAL);

  assert.equal(harness.lines[0].status, 'RUNNING');
  assert.equal(harness.lines[1].status, 'PAUSED');
  assert.equal(harness.company.credits, STARTING_CREDITS - MAINTENANCE_COST);
  assert.equal(harness.company.maintenancePaidTicks, 1);
});

test('starved lines count as active for maintenance', () => {
  const harness = setupRunningLines({
    lineCount: 2,
    tag: 'starved',
    energy: 0,
    energyPerTick: 2,
  });

  runTicks(harness.engine, MAINTENANCE_INTERVAL);

  assert.equal(harness.lines[0].status, 'RUNNING');
  assert.equal(harness.lines[1].status, 'NO_ENERGY');
  assert.equal(harness.company.credits, STARTING_CREDITS - 2 * MAINTENANCE_COST);
});

test('a shortfall empties the credits and pauses the running lines', () => {
  const harness = setupRunningLines({ lineCount: 2, tag: 'shortfall' });
  harness.company.credits = 150;

  runTicks(harness.engine, MAINTENANCE_INTERVAL);

  assert.equal(harness.company.credits, 0);
  assert.equal(harness.company.reputation, 95);
  assert.equal(harness.company.maintenancePaidTicks, 0);
  assert.equal(harness.lines[0].status, 'PAUSED');
  assert.equal(harness.lines[1].status, 'PAUSED');
});

test('a line paused by an unpaid maintenance bill stops producing', () => {
  const harness = setupRunningLines({ lineCount: 2, tag: 'halted' });
  harness.company.credits = 150;
  runTicks(harness.engine, MAINTENANCE_INTERVAL);

  // Only the two lines that were given a batch have an active batch record.
  const producing = harness.lines.slice(0, 2);
  const producedAtPause = producing.map((line) => line.totalBatchesProduced);
  const progressAtPause = producing.map((line) => activeBatchOf(line).progressTicks);

  runTicks(harness.engine, 20);

  assert.deepEqual(
    producing.map((line) => line.totalBatchesProduced),
    producedAtPause,
  );
  assert.deepEqual(
    producing.map((line) => activeBatchOf(line).progressTicks),
    progressAtPause,
  );
  assert.equal(harness.lines[0].status, 'PAUSED');
  assert.equal(harness.lines[1].status, 'PAUSED');
});
