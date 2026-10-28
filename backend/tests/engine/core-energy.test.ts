/**
 * Engine unit tests for the energy model (task T2 / spec S2).
 *
 * Documented rules (GAME_DESIGN_MVP.md §2 and §3):
 * - base generation is +20 ENERGY per tick, storage capped at 1,000;
 * - the base extraction cycle yields 5 RAW_ORE every 10 ticks for 15 ENERGY;
 * - each batch has a fixed total energy cost, spread deterministically over
 *   its duration (integer quotient per tick plus a remainder on the earliest
 *   ticks);
 * - a line that cannot pay its per-tick cost starves with status `NO_ENERGY`;
 * - from tick 900 a turbine installation adds +15 ENERGY/tick, +250 storage
 *   and one extra production line.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTRACTION_ENERGY,
  EXTRACTION_OUTPUT,
  IDLE_COMPANY,
  MANUFACTURING_COMPANY,
  METAL_COMPANY,
  activeBatchOf,
  assertRejected,
  assertSucceeded,
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

test('base generation adds 20 ENERGY per tick', () => {
  const engine = createEngine();
  const company = getCompany(engine, IDLE_COMPANY);
  assert.equal(company.energy, 400);
  assert.equal(company.energyGenerationPerTick, 20);
  assert.equal(company.maxEnergyStorage, 1000);

  runTicks(engine, 1);
  assert.equal(company.energy, 420);

  runTicks(engine, 8);
  assert.equal(company.energy, 580);
});

test('generation stops at the maximum energy storage', () => {
  const engine = createEngine();
  const company = getCompany(engine, IDLE_COMPANY);

  runTicks(engine, 31);
  assert.equal(company.energy, 975);
  runTicks(engine, 1);
  assert.equal(company.energy, 995);
  runTicks(engine, 1);
  assert.equal(company.energy, 1000);

  runTicks(engine, 12);
  assert.equal(company.energy, company.maxEnergyStorage);
});

test('the extraction cycle adds 5 RAW_ORE every 10 ticks for 15 ENERGY', () => {
  const engine = createEngine();
  const company = getCompany(engine, IDLE_COMPANY);
  assert.equal(company.inventory.RAW_ORE.available, 200);

  runTicks(engine, 9);
  assert.equal(company.inventory.RAW_ORE.available, 200);
  assert.equal(company.energy, 580);

  // Tick 10: extraction (-15) happens before that tick's generation (+20).
  runTicks(engine, 1);
  assert.equal(company.inventory.RAW_ORE.available, 205);
  assert.equal(company.energy, 585);

  runTicks(engine, 10);
  assert.equal(company.inventory.RAW_ORE.available, 210);
  assert.equal(company.energy, 770);
});

test('extraction applies to every company independently', () => {
  const engine = createEngine();
  const metallurgy = getCompany(engine, METAL_COMPANY);
  const manufacturing = getCompany(engine, MANUFACTURING_COMPANY);
  const oreBefore = metallurgy.inventory.RAW_ORE.available;

  runTicks(engine, 10);

  assert.equal(metallurgy.inventory.RAW_ORE.available, oreBefore + EXTRACTION_OUTPUT);
  assert.equal(
    manufacturing.inventory.RAW_ORE.available,
    oreBefore + EXTRACTION_OUTPUT,
  );
  assert.equal(metallurgy.energy, 400 + 10 * 20 - EXTRACTION_ENERGY);
  assert.equal(manufacturing.energy, 400 + 10 * 20 - EXTRACTION_ENERGY);
});

test('extraction is skipped while the company has less than 15 ENERGY', () => {
  for (const startingEnergy of [0, 14]) {
    const engine = createEngine();
    const company = getCompany(engine, METAL_COMPANY);
    setGrid(company, startingEnergy, 0);

    runTicks(engine, 10);

    assert.equal(
      company.inventory.RAW_ORE.available,
      200,
      `no extraction expected from ${startingEnergy} ENERGY`,
    );
    assert.equal(company.energy, startingEnergy);
  }
});

test('exactly 15 ENERGY is enough for one extraction cycle', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setGrid(company, EXTRACTION_ENERGY, 0);

  runTicks(engine, 9);
  assert.equal(company.inventory.RAW_ORE.available, 200);
  assert.equal(company.energy, EXTRACTION_ENERGY);

  runTicks(engine, 1);
  assert.equal(company.inventory.RAW_ORE.available, 200 + EXTRACTION_OUTPUT);
  assert.equal(company.energy, 0);
});

test('a batch spends its energy evenly across its ticks', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  // R1 on Class A: 10 ticks, 20 ENERGY totalling 2 ENERGY per tick.
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, 20, 0);

  startProduction(engine, 'even_energy', METAL_COMPANY, line.lineId, 'R1', 1);

  const energyPerTick: number[] = [];
  for (let tick = 0; tick < 10; tick += 1) {
    engine.processTick();
    energyPerTick.push(company.energy);
  }

  // Start 20, minus 2 per tick; the batch completes with no energy left.
  assert.deepEqual(energyPerTick, [18, 16, 14, 12, 10, 8, 6, 4, 2, 0]);
  assert.equal(line.totalBatchesProduced, 1);
  assert.equal(company.inventory.IRON_INGOT.available, 5);
  // Energy never reached the 15 ENERGY the extraction cycle needs.
  assert.equal(company.inventory.RAW_ORE.available, 0);
});

test('the energy remainder is charged to the earliest ticks of a batch', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  // R2 on Class A: 15 ticks, 35 ENERGY => 2 per tick plus a remainder of 5.
  setInventory(company, { IRON_INGOT: 4, RAW_ORE: 5 });
  setGrid(company, 35, 0);

  startProduction(engine, 'remainder_energy', METAL_COMPANY, line.lineId, 'R2', 1);
  engine.processTick();

  const batch = activeBatchOf(line);
  assert.equal(batch.energyPerTick, 2);
  assert.equal(batch.energyRemainder, 5);

  const energyAfterEachTick = [company.energy];
  for (let tick = 0; tick < 14; tick += 1) {
    engine.processTick();
    energyAfterEachTick.push(company.energy);
  }

  // The 5 extra units are charged on ticks 1..5, so the curve drops by 3 five
  // times and by 2 for the remaining ten ticks.
  assert.deepEqual(energyAfterEachTick, [
    32, 29, 26, 23, 20, 18, 16, 14, 12, 10, 8, 6, 4, 2, 0,
  ]);
  assert.equal(line.totalBatchesProduced, 1);
  assert.equal(company.inventory.STEEL_PLATE.available, 4);
});

test('a line below its per-tick energy cost starves without spending energy', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, 5, 0);

  startProduction(engine, 'starve', METAL_COMPANY, line.lineId, 'R1', 1);

  runTicks(engine, 1);
  assert.equal(activeBatchOf(line).progressTicks, 1);
  assert.equal(company.energy, 3);

  runTicks(engine, 1);
  assert.equal(activeBatchOf(line).progressTicks, 2);
  assert.equal(company.energy, 1);

  runTicks(engine, 4);
  assert.equal(line.status, 'NO_ENERGY');
  assert.equal(activeBatchOf(line).progressTicks, 2);
  assert.equal(company.energy, 1);
  assert.equal(line.totalBatchesProduced, 0);
});

test('a starved line resumes producing when the grid refills', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, 1, 0);

  startProduction(engine, 'starve_then_refill', METAL_COMPANY, line.lineId, 'R1', 1);
  runTicks(engine, 1);
  assert.equal(line.status, 'NO_ENERGY');
  assert.equal(activeBatchOf(line).progressTicks, 0);

  company.energyGenerationPerTick = 20;
  runTicks(engine, 1);

  assert.equal(line.status, 'RUNNING');
  assert.equal(activeBatchOf(line).progressTicks, 1);
});

test('energy stays inside [0, maxEnergyStorage] during a long deterministic run', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setInventory(company, { RAW_ORE: 2000 });
  for (const line of company.lines.slice(0, 2)) {
    startProduction(engine, `band_${line.lineId}`, METAL_COMPANY, line.lineId, 'R1', 100);
  }

  for (let tick = 0; tick < 600; tick += 1) {
    engine.processTick();
    assert.ok(company.energy >= 0, `energy went negative at tick ${engine.getCurrentTick()}`);
    assert.ok(
      company.energy <= company.maxEnergyStorage,
      `energy exceeded storage at tick ${engine.getCurrentTick()}`,
    );
  }

  // Two R1 lines drain 2 ENERGY each, so the grid sits one tick below its cap.
  assert.equal(company.energy, company.maxEnergyStorage - 4);
});

test('turbine expansion is locked before tick 900', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setInventory(company, { IND_TURBINE: 1 });

  submitCommand(engine, 'early_turbine', {
    type: 'INSTALL_TURBINE_EXPANSION',
    companyId: METAL_COMPANY,
  });
  runTicks(engine, 1);

  assertRejected(lastExecution(engine), 'ERR_EXPANSION_LOCKED');
  assert.equal(company.energyGenerationPerTick, 20);
  assert.equal(company.maxEnergyStorage, 1000);
  assert.equal(company.lines.length, 3);
  assert.equal(company.inventory.IND_TURBINE.available, 1);
});

test('installing a turbine expands generation, storage and the line count', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setInventory(company, { IND_TURBINE: 2 });

  runTicks(engine, 900);
  assert.equal(engine.getCurrentTick(), 900);
  assert.equal(company.energy, 1000);

  submitCommand(
    engine,
    'turbine_expansion',
    { type: 'INSTALL_TURBINE_EXPANSION', companyId: METAL_COMPANY },
    engine.getCurrentTick() + 1,
  );
  runTicks(engine, 1);

  assertSucceeded(lastExecution(engine));
  assert.equal(company.installedTurbinesR7, 1);
  assert.equal(company.inventory.IND_TURBINE.available, 1);
  assert.equal(company.energyGenerationPerTick, 35);
  assert.equal(company.maxEnergyStorage, 1250);
  assert.equal(company.lines.length, 4);

  const newLine = getLineByIndex(engine, METAL_COMPANY, 3);
  assert.equal(newLine.priority, 2);
  assert.equal(newLine.status, 'IDLE');
  assert.equal(newLine.activeBatch, null);

  runTicks(engine, 20);
  assert.equal(company.energy, company.maxEnergyStorage);
});

test('turbine expansion requires an IND_TURBINE in inventory', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setInventory(company, {});

  runTicks(engine, 900);
  submitCommand(
    engine,
    'turbine_without_part',
    { type: 'INSTALL_TURBINE_EXPANSION', companyId: METAL_COMPANY },
    engine.getCurrentTick() + 1,
  );
  runTicks(engine, 1);

  assertRejected(lastExecution(engine), 'ERR_MISSING_TURBINE');
  assert.equal(company.installedTurbinesR7, 0);
  assert.equal(company.energyGenerationPerTick, 20);
  assert.equal(company.maxEnergyStorage, 1000);
  assert.equal(company.lines.length, 3);
});
