/**
 * Shared helpers for the engine unit tests (`tests/engine/core-*.test.ts`).
 *
 * Every test builds its own `SimulatorEngine` from an explicit seed, so the
 * whole suite is deterministic (assumption A3) and no test observes another
 * test's state. Helpers only touch state that the engine exposes publicly
 * (`getCompany`, `submitCommand`, `processTick`, `getExecutionHistory`).
 *
 * The documented rules these tests assert live in
 * `public/assets/aistudio/GAME_DESIGN_MVP_6939a978.md` (recipes, energy,
 * maintenance) and in the engine constants in `src/engine/SimulatorEngine.ts`.
 */

import assert from 'node:assert/strict';

import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import type {
  CommandExecutionResult,
  CompanyState,
  DistributiveOmit,
  EnqueueCommandInput,
  ItemId,
  ProductionBatch,
  ProductionLine,
  RecipeId,
} from '../../src/domain/types.ts';

/** Default engine seed; matches the constructor default and docs assumption A3. */
export const DEFAULT_SEED = 42107;

/** Class A (Metallurgy) company of the standard 4-company match. */
export const METAL_COMPANY = 'comp_metal_01';

/** Class B (Manufacturing) company of the standard 4-company match. */
export const MANUFACTURING_COMPANY = 'comp_manuf_01';

/** NPC company that the tests keep idle unless stated otherwise. */
export const IDLE_COMPANY = 'comp_metal_02';

export const RAW_ORE = 'RAW_ORE' as const;

/** Documented base extraction cycle: 5 RAW_ORE every 10 ticks for 15 ENERGY. */
export const EXTRACTION_TICKS = 10;
export const EXTRACTION_OUTPUT = 5;
export const EXTRACTION_ENERGY = 15;

export type CommandPayload = DistributiveOmit<
  EnqueueCommandInput,
  'commandId' | 'idempotencyKey' | 'scheduledTick'
>;

/** Create a freshly initialized standard match with an explicit seed. */
export function createEngine(seed: number = DEFAULT_SEED): SimulatorEngine {
  const engine = new SimulatorEngine(seed);
  engine.initializeStandardMatch();
  return engine;
}

export function getCompany(engine: SimulatorEngine, companyId: string): CompanyState {
  const company = engine.getCompany(companyId);
  assert.ok(company, `company ${companyId} must exist in the standard match`);
  return company;
}

/**
 * Replace a company's whole stock with exactly the given amounts; every item
 * that is not listed ends up empty. This keeps material assertions exact.
 */
export function setInventory(
  company: CompanyState,
  stock: Partial<Record<ItemId, number>>,
): void {
  for (const itemId of Object.keys(company.inventory) as ItemId[]) {
    company.inventory[itemId].available = stock[itemId] ?? 0;
    company.inventory[itemId].reserved = 0;
  }
}

/**
 * Pin the electric grid to an explicit state so per-tick energy accounting is
 * completely predictable (no hidden refills from the base +20/tick).
 */
export function setGrid(company: CompanyState, energy: number, generationPerTick: number): void {
  company.energy = energy;
  company.energyGenerationPerTick = generationPerTick;
}

export function getLineByIndex(
  engine: SimulatorEngine,
  companyId: string,
  index: number,
): ProductionLine {
  const company = getCompany(engine, companyId);
  const line = company.lines[index];
  assert.ok(line, `company ${companyId} must have a line at index ${index}`);
  return line;
}

export function getLine(
  engine: SimulatorEngine,
  companyId: string,
  lineId: string,
): ProductionLine {
  const company = getCompany(engine, companyId);
  const line = company.lines.find((candidate) => candidate.lineId === lineId);
  assert.ok(line, `line ${lineId} must exist in company ${companyId}`);
  return line;
}

/** The active batch of a line; fails loudly when the line is not producing. */
export function activeBatchOf(line: ProductionLine): ProductionBatch {
  assert.ok(line.activeBatch, `line ${line.lineId} must have an active batch`);
  return line.activeBatch;
}

/**
 * Enqueue a command for the next tick (or an explicit tick) and assert that the
 * authoritative queue accepted it.
 */
export function submitCommand(
  engine: SimulatorEngine,
  tag: string,
  payload: CommandPayload,
  scheduledTick: number = engine.getCurrentTick() + 1,
): void {
  const command = {
    ...payload,
    commandId: `cmd_${tag}`,
    idempotencyKey: `idem_${tag}`,
    scheduledTick,
  } as EnqueueCommandInput;
  assert.equal(engine.submitCommand(command), true, `command "${tag}" must be queued`);
}

/** Queue a SET_PRODUCTION_TARGET for the given line on the next tick. */
export function startProduction(
  engine: SimulatorEngine,
  tag: string,
  companyId: string,
  lineId: string,
  recipeId: RecipeId,
  targetBatches = 1,
): void {
  submitCommand(engine, tag, {
    type: 'SET_PRODUCTION_TARGET',
    companyId,
    lineId,
    recipeId,
    targetBatches,
  });
}

export function runTicks(engine: SimulatorEngine, ticks: number): void {
  for (let index = 0; index < ticks; index += 1) {
    engine.processTick();
  }
}

/** Advance until `predicate` holds; returns the number of ticks consumed. */
export function runUntil(
  engine: SimulatorEngine,
  predicate: () => boolean,
  maxTicks: number,
  description: string,
): number {
  for (let tick = 0; tick < maxTicks; tick += 1) {
    engine.processTick();
    if (predicate()) {
      return tick + 1;
    }
  }
  assert.fail(`"${description}" was not reached within ${maxTicks} ticks`);
}

/** The most recently executed command result. */
export function lastExecution(engine: SimulatorEngine): CommandExecutionResult {
  const result = engine.getExecutionHistory(1).at(-1);
  assert.ok(result, 'at least one command must have been executed');
  return result;
}

export function assertSucceeded(result: CommandExecutionResult): void {
  assert.equal(
    result.success,
    true,
    `command ${result.commandId} should succeed but failed with ${result.errorCode}`,
  );
}

export function assertRejected(result: CommandExecutionResult, errorCode: string): void {
  assert.equal(result.success, false, `command ${result.commandId} should be rejected`);
  assert.equal(result.errorCode, errorCode);
}

/** Energy the documented extraction cycle is expected to consume over `ticks`. */
export function extractionEnergyFor(ticks: number): number {
  return Math.floor(ticks / EXTRACTION_TICKS) * EXTRACTION_ENERGY;
}

/** RAW_ORE the documented extraction cycle is expected to add over `ticks`. */
export function extractionOutputFor(ticks: number): number {
  return Math.floor(ticks / EXTRACTION_TICKS) * EXTRACTION_OUTPUT;
}
