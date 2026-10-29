/**
 * Engine unit tests for recipes R1–R8 (task T2 / spec S2).
 *
 * The numbers asserted here are the documented balance table in
 * `public/assets/aistudio/GAME_DESIGN_MVP_6939a978.md` ("3. Catálogo de las 8
 * Recetas y Balance Matemático"): per-batch inputs, output quantity, duration
 * and total energy cost for Class A (Metallurgy) and Class B (Manufacturing).
 * The table is transcribed literally instead of imported from the catalog so
 * the tests fail if the catalog drifts from the design document.
 *
 * Every scenario starts from an explicit seed, an exact inventory, pinned
 * energy and zero generation, so material and energy deltas are exact.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { EnqueueCommandInput, IndustrialClass, ItemId, RecipeId } from '../../src/domain/types.ts';
import {
  MANUFACTURING_COMPANY,
  METAL_COMPANY,
  activeBatchOf,
  assertRejected,
  assertSucceeded,
  createEngine,
  extractionEnergyFor,
  extractionOutputFor,
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

interface ClassProfile {
  readonly durationTicks: number;
  readonly energyCost: number;
}

interface DocumentedRecipe {
  readonly id: RecipeId;
  readonly outputItem: ItemId;
  readonly outputQuantity: number;
  readonly inputs: ReadonlyArray<{ readonly itemId: ItemId; readonly quantity: number }>;
  readonly classA: ClassProfile;
  readonly classB: ClassProfile;
}

/** GAME_DESIGN_MVP.md §3, transcribed verbatim. */
const RECIPES: readonly DocumentedRecipe[] = [
  {
    id: 'R1',
    outputItem: 'IRON_INGOT',
    outputQuantity: 5,
    inputs: [{ itemId: 'RAW_ORE', quantity: 10 }],
    classA: { durationTicks: 10, energyCost: 20 },
    classB: { durationTicks: 20, energyCost: 40 },
  },
  {
    id: 'R2',
    outputItem: 'STEEL_PLATE',
    outputQuantity: 4,
    inputs: [
      { itemId: 'IRON_INGOT', quantity: 4 },
      { itemId: 'RAW_ORE', quantity: 5 },
    ],
    classA: { durationTicks: 15, energyCost: 35 },
    classB: { durationTicks: 30, energyCost: 70 },
  },
  {
    id: 'R3',
    outputItem: 'HEAVY_ALLOY',
    outputQuantity: 2,
    inputs: [
      { itemId: 'STEEL_PLATE', quantity: 4 },
      { itemId: 'RAW_ORE', quantity: 10 },
    ],
    classA: { durationTicks: 25, energyCost: 60 },
    classB: { durationTicks: 55, energyCost: 120 },
  },
  {
    id: 'R4',
    outputItem: 'MECH_FRAME',
    outputQuantity: 2,
    inputs: [
      { itemId: 'STEEL_PLATE', quantity: 4 },
      { itemId: 'IRON_INGOT', quantity: 2 },
    ],
    classA: { durationTicks: 30, energyCost: 60 },
    classB: { durationTicks: 15, energyCost: 30 },
  },
  {
    id: 'R5',
    outputItem: 'CTRL_CIRCUIT',
    outputQuantity: 2,
    inputs: [
      { itemId: 'IRON_INGOT', quantity: 2 },
      { itemId: 'RAW_ORE', quantity: 6 },
    ],
    classA: { durationTicks: 40, energyCost: 80 },
    classB: { durationTicks: 20, energyCost: 35 },
  },
  {
    id: 'R6',
    outputItem: 'POWER_MODULE',
    outputQuantity: 1,
    inputs: [
      { itemId: 'MECH_FRAME', quantity: 2 },
      { itemId: 'CTRL_CIRCUIT', quantity: 2 },
      { itemId: 'HEAVY_ALLOY', quantity: 2 },
    ],
    classA: { durationTicks: 50, energyCost: 110 },
    classB: { durationTicks: 25, energyCost: 50 },
  },
  {
    id: 'R7',
    outputItem: 'IND_TURBINE',
    outputQuantity: 1,
    inputs: [
      { itemId: 'POWER_MODULE', quantity: 2 },
      { itemId: 'HEAVY_ALLOY', quantity: 4 },
    ],
    classA: { durationTicks: 40, energyCost: 90 },
    classB: { durationTicks: 40, energyCost: 90 },
  },
  {
    id: 'R8',
    outputItem: 'MEGAMACHINE_PART',
    outputQuantity: 1,
    inputs: [
      { itemId: 'IND_TURBINE', quantity: 2 },
      { itemId: 'MECH_FRAME', quantity: 4 },
      { itemId: 'STEEL_PLATE', quantity: 4 },
    ],
    classA: { durationTicks: 60, energyCost: 150 },
    classB: { durationTicks: 60, energyCost: 150 },
  },
];

interface ClassCase {
  readonly label: IndustrialClass;
  readonly companyId: string;
  readonly profileKey: 'classA' | 'classB';
}

const CLASS_CASES: readonly ClassCase[] = [
  { label: 'CLASS_A_METALLURGY', companyId: METAL_COMPANY, profileKey: 'classA' },
  { label: 'CLASS_B_MANUFACTURING', companyId: MANUFACTURING_COMPANY, profileKey: 'classB' },
];

function recipeById(recipeId: RecipeId): DocumentedRecipe {
  const recipe = RECIPES.find((candidate) => candidate.id === recipeId);
  assert.ok(recipe, `recipe ${recipeId} must be documented in the balance table`);
  return recipe;
}

/** Exact per-batch input stock: nothing more, nothing less. */
function stockFor(recipe: DocumentedRecipe): Partial<Record<ItemId, number>> {
  const stock: Partial<Record<ItemId, number>> = {};
  for (const input of recipe.inputs) {
    stock[input.itemId] = input.quantity;
  }
  return stock;
}

const ENERGY_MEASUREMENT_START = 400;

interface Measurement {
  readonly ticks: number;
  readonly recipeEnergy: number;
}

/** Run one batch on the `classCase` class and measure its time and energy cost. */
function measureRecipe(recipe: DocumentedRecipe, classCase: ClassCase): Measurement {
  const engine = createEngine();
  const company = getCompany(engine, classCase.companyId);
  const line = getLineByIndex(engine, classCase.companyId, 0);
  setInventory(company, stockFor(recipe));
  setGrid(company, ENERGY_MEASUREMENT_START, 0);
  startProduction(
    engine,
    `measure_${recipe.id}_${classCase.profileKey}`,
    classCase.companyId,
    line.lineId,
    recipe.id,
    1,
  );
  const ticks = runUntil(
    engine,
    () => line.totalBatchesProduced === 1,
    300,
    `${recipe.id} batch on ${classCase.label}`,
  );
  return {
    ticks,
    recipeEnergy:
      ENERGY_MEASUREMENT_START - company.energy - extractionEnergyFor(ticks),
  };
}

for (const recipe of RECIPES) {
  for (const classCase of CLASS_CASES) {
    const profile = recipe[classCase.profileKey];

    test(`${recipe.id} yields ${recipe.outputQuantity} ${recipe.outputItem} on ${classCase.label} in ${profile.durationTicks} ticks`, () => {
      const engine = createEngine();
      const company = getCompany(engine, classCase.companyId);
      const line = getLineByIndex(engine, classCase.companyId, 0);
      setInventory(company, stockFor(recipe));
      // Start at full storage with no generation: every energy unit spent is
      // attributable to this batch (plus the documented extraction cycle).
      setGrid(company, company.maxEnergyStorage, 0);

      startProduction(
        engine,
        `start_${recipe.id}_${classCase.profileKey}`,
        classCase.companyId,
        line.lineId,
        recipe.id,
        1,
      );
      runTicks(engine, 1);

      const batch = activeBatchOf(line);
      assert.equal(batch.recipeId, recipe.id);
      assert.equal(batch.totalDurationTicks, profile.durationTicks);
      // Energy is spread deterministically: integer quotient per tick plus a
      // remainder charged to the earliest ticks of the batch.
      assert.equal(batch.energyPerTick, Math.floor(profile.energyCost / profile.durationTicks));
      assert.equal(batch.energyRemainder, profile.energyCost % profile.durationTicks);

      // The tick before the documented duration the batch must still be open.
      runTicks(engine, profile.durationTicks - 2);
      assert.equal(engine.getCurrentTick(), profile.durationTicks - 1);
      assert.equal(line.totalBatchesProduced, 0);
      assert.equal(company.inventory[recipe.outputItem].available, 0);

      runTicks(engine, 1);
      assert.equal(line.totalBatchesProduced, 1);
      assert.equal(company.inventory[recipe.outputItem].available, recipe.outputQuantity);
      assert.equal(line.status, 'IDLE');
      assert.equal(line.activeBatch, null);

      // Non-ore inputs are fully consumed; RAW_ORE equals what the company-wide
      // extraction cycle added over the run.
      for (const input of recipe.inputs) {
        if (input.itemId === 'RAW_ORE') {
          continue;
        }
        assert.equal(
          company.inventory[input.itemId].available,
          0,
          `${input.itemId} input should be fully consumed`,
        );
      }
      const cycles = Math.floor(profile.durationTicks / 10);
      assert.equal(company.inventory.RAW_ORE.available, extractionOutputFor(profile.durationTicks));
      assert.equal(company.inventory.RAW_ORE.available, cycles * 5);

      // Full energy accounting: the documented batch cost plus one extraction
      // cycle (15 ENERGY) per 10 ticks.
      assert.equal(
        company.energy,
        company.maxEnergyStorage -
          profile.energyCost -
          extractionEnergyFor(profile.durationTicks),
      );
    });
  }
}

test('inputs are deducted when a batch starts, before any output exists', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, company.maxEnergyStorage, 0);

  startProduction(engine, 'deduct_on_start', METAL_COMPANY, line.lineId, 'R1', 1);
  runTicks(engine, 1);

  assert.equal(company.inventory.RAW_ORE.available, 0);
  assert.equal(company.inventory.IRON_INGOT.available, 0);
  assert.equal(activeBatchOf(line).progressTicks, 1);
  assert.equal(line.status, 'RUNNING');
});

test('a production target without its inputs is rejected and deducts nothing', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  // R2 needs 4 IRON_INGOT + 5 RAW_ORE; one ingot is missing.
  setInventory(company, { IRON_INGOT: 3, RAW_ORE: 5 });
  setGrid(company, company.maxEnergyStorage, 0);

  startProduction(engine, 'no_inputs', METAL_COMPANY, line.lineId, 'R2', 1);
  runTicks(engine, 1);

  assertRejected(lastExecution(engine), 'ERR_INSUFFICIENT_INVENTORY');
  assert.equal(company.inventory.IRON_INGOT.available, 3);
  assert.equal(company.inventory.RAW_ORE.available, 5);
  assert.equal(line.status, 'IDLE');
  assert.equal(line.activeBatch, null);
});

test('a non-positive batch count is rejected', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, company.maxEnergyStorage, 0);

  startProduction(engine, 'zero_batches', METAL_COMPANY, line.lineId, 'R1', 0);
  runTicks(engine, 1);

  assertRejected(lastExecution(engine), 'ERR_INVALID_BATCH_COUNT');
  // The rejected target never touched the reserved inputs.
  assert.equal(company.inventory.RAW_ORE.available, 10);
  assert.equal(line.activeBatch, null);
});

test('a production target for an unknown line is rejected', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  setInventory(company, { RAW_ORE: 10 });
  setGrid(company, company.maxEnergyStorage, 0);

  startProduction(engine, 'unknown_line', METAL_COMPANY, 'comp_metal_01_line_99', 'R1', 1);
  runTicks(engine, 1);

  assertRejected(lastExecution(engine), 'ERR_LINE_NOT_FOUND');
  assert.equal(company.inventory.RAW_ORE.available, 10);
});

test('a second production target on a line with an active batch is rejected without discarding work (issue #48)', () => {
  const engine = createEngine();
  const company = getCompany(engine, METAL_COMPANY);
  const line = getLineByIndex(engine, METAL_COMPANY, 0);
  setInventory(company, { RAW_ORE: 25 });
  setGrid(company, company.maxEnergyStorage, 0);

  startProduction(engine, 'first_batch', METAL_COMPANY, line.lineId, 'R1', 1);
  runTicks(engine, 1);
  assertSucceeded(lastExecution(engine));
  const batch = structuredClone(activeBatchOf(line));
  const inventoryAfterFirst = company.inventory.RAW_ORE.available;

  startProduction(engine, 'second_batch', METAL_COMPANY, line.lineId, 'R1', 1);
  runTicks(engine, 1);

  const rejection = lastExecution(engine);
  assertRejected(rejection, 'ERR_LINE_BUSY');
  assert.equal(rejection.errorMessage, 'Line already has an active batch');
  // The rejected target never deducted the second batch's inputs.
  assert.equal(company.inventory.RAW_ORE.available, inventoryAfterFirst);
  // The in-flight batch keeps its identity and only advances its own progress.
  assert.equal(activeBatchOf(line).recipeId, batch.recipeId);
  assert.equal(activeBatchOf(line).targetBatches, batch.targetBatches);
  assert.equal(activeBatchOf(line).completedBatches, batch.completedBatches);
  assert.equal(activeBatchOf(line).progressTicks, batch.progressTicks + 1);
  assert.equal(line.status, 'RUNNING');

  // Exact retries are deduplicated by idempotency and never re-execute.
  assert.equal(engine.submitCommand({
    type: 'SET_PRODUCTION_TARGET',
    companyId: METAL_COMPANY,
    lineId: line.lineId,
    recipeId: 'R1',
    targetBatches: 1,
    commandId: 'cmd_first_batch_retry',
    idempotencyKey: 'idem_first_batch',
    scheduledTick: engine.getCurrentTick() + 1,
  } as EnqueueCommandInput), false);
  assert.equal(engine.submitCommand({
    type: 'SET_PRODUCTION_TARGET',
    companyId: METAL_COMPANY,
    lineId: line.lineId,
    recipeId: 'R1',
    targetBatches: 1,
    commandId: 'cmd_second_batch_retry',
    idempotencyKey: 'idem_second_batch',
    scheduledTick: engine.getCurrentTick() + 1,
  } as EnqueueCommandInput), false);
});

test('a production target for an unknown company is rejected', () => {
  const engine = createEngine();

  startProduction(engine, 'unknown_company', 'comp_missing', 'comp_missing_line_1', 'R1', 1);
  runTicks(engine, 1);

  assertRejected(lastExecution(engine), 'ERR_COMPANY_NOT_FOUND');
});

test('class specialisation penalises off-class recipes and is neutral for R7 and R8', () => {
  const classA = CLASS_CASES[0];
  const classB = CLASS_CASES[1];

  // Metallurgy recipes cost the manufacturing class more time and energy.
  for (const recipeId of ['R1', 'R2', 'R3'] as const) {
    const recipe = recipeById(recipeId);
    const onClass = measureRecipe(recipe, classA);
    const offClass = measureRecipe(recipe, classB);
    assert.ok(offClass.ticks > onClass.ticks, `${recipeId} should be slower on Class B`);
    assert.ok(offClass.recipeEnergy > onClass.recipeEnergy, `${recipeId} should cost more on Class B`);
  }

  // Manufacturing recipes cost the metallurgy class more time and energy.
  for (const recipeId of ['R4', 'R5', 'R6'] as const) {
    const recipe = recipeById(recipeId);
    const onClass = measureRecipe(recipe, classB);
    const offClass = measureRecipe(recipe, classA);
    assert.ok(offClass.ticks > onClass.ticks, `${recipeId} should be slower on Class A`);
    assert.ok(offClass.recipeEnergy > onClass.recipeEnergy, `${recipeId} should cost more on Class A`);
  }

  // R7 and R8 are documented as neutral for both classes.
  for (const recipeId of ['R7', 'R8'] as const) {
    const recipe = recipeById(recipeId);
    const onA = measureRecipe(recipe, classA);
    const onB = measureRecipe(recipe, classB);
    assert.deepEqual(onB, onA);
    assert.equal(onA.recipeEnergy, recipe.classA.energyCost);
  }
});

test('a produced R8 megamachine part is deliverable to the global project', () => {
  const engine = createEngine();
  const company = getCompany(engine, MANUFACTURING_COMPANY);
  const line = getLineByIndex(engine, MANUFACTURING_COMPANY, 0);
  const recipe = recipeById('R8');
  setInventory(company, stockFor(recipe));
  setGrid(company, company.maxEnergyStorage, 0);

  startProduction(engine, 'r8_part', MANUFACTURING_COMPANY, line.lineId, 'R8', 1);
  runTicks(engine, recipe.classB.durationTicks);
  assert.equal(company.inventory.MEGAMACHINE_PART.available, 1);

  submitCommand(engine, 'deliver_part', {
    type: 'DELIVER_MEGAMACHINE_PART',
    companyId: MANUFACTURING_COMPANY,
    quantity: 1,
  });
  runTicks(engine, 1);

  assertSucceeded(lastExecution(engine));
  assert.equal(company.inventory.MEGAMACHINE_PART.available, 0);
  assert.equal(company.contributedMegamachinePartsR8, 1);
  assert.equal(engine.getGlobalProject().deliveredMegamachineParts, 1);

  submitCommand(engine, 'deliver_again', {
    type: 'DELIVER_MEGAMACHINE_PART',
    companyId: MANUFACTURING_COMPANY,
    quantity: 1,
  });
  runTicks(engine, 1);

  assertRejected(lastExecution(engine), 'ERR_INSUFFICIENT_MEGAMACHINE_PARTS');
  assert.equal(engine.getGlobalProject().deliveredMegamachineParts, 1);
});
