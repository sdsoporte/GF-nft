/**
 * Shared, deterministic scaffolding for the seeded property/scenario suite (spec S3).
 *
 * The suite drives a FIXED corpus of literal seeds through scripted command/tick
 * sequences and asserts engine invariants after every tick:
 *
 * - material conservation with explicit, declared sources and sinks,
 * - non-negative inventories, energy, credits, collateral and counters,
 * - monotonic counters the engine actually guarantees.
 *
 * Determinism (assumption A3): the literal seed handed to `new SimulatorEngine(seed)`
 * is the only randomness source in the system under test. This file never calls
 * `Math.random`, `Date.now` or any other wall-clock/unseeded generator.
 *
 * ---------------------------------------------------------------------------
 * Material accounting model
 * ---------------------------------------------------------------------------
 * Every inventory mutation in `src/engine/SimulatorEngine.ts` is one of:
 *
 *   SOURCE  `processRawOreExtraction`  +5 RAW_ORE per company every 10 ticks
 *                                      (only when the company holds >= 15 ENERGY)
 *   SOURCE  `completeBatch`            credits the recipe output on the line
 *   SINK    `deductRecipeInputs`       consumes recipe inputs; while the batch is
 *                                      active that material is still owned by the
 *                                      company as work-in-progress (WIP), and it is
 *                                      re-emitted by `completeBatch`, so the pair is
 *                                      mass-neutral
 *   SINK    `INSTALL_TURBINE_EXPANSION` consumes 1 IND_TURBINE into
 *                                      `installedTurbinesR7` (sunk into the grid)
 *   SINK    `DELIVER_MEGAMACHINE_PART`  moves MEGAMACHINE_PART into
 *                                      `contributedMegamachinePartsR8` (and into the
 *                                      global project counter)
 *   TRANSFER `SCHEDULE_INTERNAL_TRANSPORT` seller -> buyer (net zero)
 *
 * To turn those rules into a single conserved scalar, each item gets an integer
 * "raw ore equivalent" weight derived from the recipe catalog itself: a batch of
 * R3 consumes 4 STEEL_PLATE plus 10 RAW_ORE and produces 2 HEAVY_ALLOY, so
 * `4 * w(STEEL_PLATE) + 10 * w(RAW_ORE) === 2 * w(HEAVY_ALLOY)`. Starting from
 * `w(RAW_ORE) = 4` (the smallest scale that keeps every weight integral) every
 * recipe in the catalog yields an exact integer weight, so the total mass
 * `M(t) = sum(w(item) * available) + sunk turbines + delivered parts + WIP`
 * may only grow by raw ore extraction.
 *
 * ---------------------------------------------------------------------------
 * Scenarios deliberately avoid one engine behavior
 * ---------------------------------------------------------------------------
 * `SET_PRODUCTION_TARGET` executed on a line that already owns an `activeBatch`
 * deducts the new batch inputs and then overwrites the batch, discarding the WIP
 * of the in-flight batch. That would destroy material that this accounting model
 * legitimately treats as owned, so no scenario re-targets an active line. Every
 * scenario targets each line at most once (pause/resume/priority changes are
 * safe and are exercised).
 */

import { ITEM_IDS, RAW_ORE_EXTRACTION, RECIPE_CATALOG } from '../../src/domain/recipeCatalog.ts';
import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import type {
  CompanyState,
  DistributiveOmit,
  GameCommand,
  ItemId,
  LinePriority,
  LineStatus,
  RecipeId,
  SimulationSnapshot,
} from '../../src/domain/types.ts';

/** Standard-match company ids created by `initializeStandardMatch`. */
export const METAL_A = 'comp_metal_01'; // CLASS_A_METALLURGY
export const METAL_B = 'comp_metal_02'; // CLASS_A_METALLURGY (NPC)
export const MANUF_A = 'comp_manuf_01'; // CLASS_B_MANUFACTURING
export const MANUF_B = 'comp_manuf_02'; // CLASS_B_MANUFACTURING (NPC)

/** Line statuses that the engine bills for maintenance. */
const BILLABLE_LINE_STATUSES: readonly LineStatus[] = ['RUNNING', 'NO_ENERGY'];

const RECIPE_ORDER: readonly RecipeId[] = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'];

/**
 * Smallest positive scale that keeps every weight in the catalog integral; see
 * the module comment for the derivation.
 */
const RAW_ORE_WEIGHT = 4;

/**
 * Derive one integer raw-ore-equivalent weight per item from the recipe catalog.
 * The catalog is ordered topologically (R1..R8), so each recipe only depends on
 * items whose weight is already known.
 */
export function deriveMaterialWeights(): Record<ItemId, number> {
  const weights = { RAW_ORE: RAW_ORE_WEIGHT } as Record<ItemId, number>;

  for (const recipeId of RECIPE_ORDER) {
    const recipe = RECIPE_CATALOG[recipeId];
    let numerator = 0;
    for (const requirement of recipe.inputs) {
      const inputWeight = weights[requirement.itemId];
      if (inputWeight === undefined) {
        throw new Error(
          `[property] recipe ${recipeId} depends on ${requirement.itemId} before its weight is known`,
        );
      }
      numerator += inputWeight * requirement.quantity;
    }
    if (numerator % recipe.outputQuantity !== 0) {
      throw new Error(
        `[property] recipe ${recipeId} is not mass-closed: ${numerator} / ${recipe.outputQuantity}`,
      );
    }
    const outputWeight = weights[recipe.outputItem];
    if (outputWeight !== undefined && outputWeight !== numerator / recipe.outputQuantity) {
      throw new Error(
        `[property] recipe ${recipeId} gives ${recipe.outputItem} two different weights`,
      );
    }
    weights[recipe.outputItem] = numerator / recipe.outputQuantity;
  }

  for (const itemId of Object.keys(ITEM_IDS) as ItemId[]) {
    if (!Number.isSafeInteger(weights[itemId]) || weights[itemId] <= 0) {
      throw new Error(`[property] missing or invalid material weight for ${itemId}`);
    }
  }
  return weights;
}

/** Raw-ore-equivalent weight per item, derived once from the frozen catalog. */
export const MATERIAL_WEIGHTS: Readonly<Record<ItemId, number>> = Object.freeze(
  deriveMaterialWeights(),
);

/** Material mass of the inputs consumed by one batch of `recipeId`. */
export function batchInputMass(recipeId: RecipeId): number {
  const recipe = RECIPE_CATALOG[recipeId];
  return recipe.inputs.reduce(
    (sum, requirement) => sum + MATERIAL_WEIGHTS[requirement.itemId] * requirement.quantity,
    0,
  );
}

/**
 * Total material mass owned by the match: free inventory, material sunk into
 * installed turbines, parts delivered to the global project, and the WIP of
 * every active batch (one batch worth of inputs per active batch).
 */
export function computeMaterialMass(engine: SimulatorEngine): number {
  let mass = 0;
  for (const company of engine.getAllCompanies()) {
    for (const itemId of Object.keys(ITEM_IDS) as ItemId[]) {
      mass += MATERIAL_WEIGHTS[itemId] * company.inventory[itemId].available;
    }
    mass += MATERIAL_WEIGHTS.IND_TURBINE * company.installedTurbinesR7;
    mass += MATERIAL_WEIGHTS.MEGAMACHINE_PART * company.contributedMegamachinePartsR8;
    for (const line of company.lines) {
      if (line.activeBatch) {
        mass += batchInputMass(line.activeBatch.recipeId);
      }
    }
  }
  return mass;
}

/** Number of companies that satisfy the extraction precondition during `tick`. */
export function countExtractingCompanies(before: SimulationSnapshot, tick: number): number {
  if (tick % RAW_ORE_EXTRACTION.ticksPerCycle !== 0) {
    return 0;
  }
  return Object.values(before.companies).filter(
    (company) => company.energy >= RAW_ORE_EXTRACTION.energyCostPerCycle,
  ).length;
}

/** Material mass added by one company extracting one raw ore cycle. */
export const EXTRACTION_MASS_PER_COMPANY =
  RAW_ORE_EXTRACTION.outputQuantity * MATERIAL_WEIGHTS.RAW_ORE;

/** Lines the engine charges maintenance for, measured on a settled snapshot. */
export function countBillableLines(company: CompanyState): number {
  return company.lines.filter((line) => BILLABLE_LINE_STATUSES.includes(line.status)).length;
}

/** Sum of spendable credits across every company. */
export function totalCredits(snapshot: SimulationSnapshot): number {
  return Object.values(snapshot.companies).reduce((sum, company) => sum + company.credits, 0);
}

function checkCounter(violations: string[], path: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    violations.push(`${path}=${String(value)}`);
  }
}

/**
 * Non-negativity and integrality violations of a settled snapshot. Returns
 * `path=value` strings so a failing assertion names the offending field.
 */
export function collectNonNegativeViolations(snapshot: SimulationSnapshot): string[] {
  const violations: string[] = [];
  checkCounter(violations, 'tick', snapshot.tick);

  for (const [companyId, company] of Object.entries(snapshot.companies)) {
    checkCounter(violations, `${companyId}.credits`, company.credits);
    checkCounter(violations, `${companyId}.energy`, company.energy);
    checkCounter(violations, `${companyId}.maxEnergyStorage`, company.maxEnergyStorage);
    checkCounter(violations, `${companyId}.energyGenerationPerTick`, company.energyGenerationPerTick);
    checkCounter(violations, `${companyId}.reputation`, company.reputation);
    checkCounter(violations, `${companyId}.installedTurbinesR7`, company.installedTurbinesR7);
    checkCounter(
      violations,
      `${companyId}.contributedMegamachinePartsR8`,
      company.contributedMegamachinePartsR8,
    );
    checkCounter(violations, `${companyId}.maintenancePaidTicks`, company.maintenancePaidTicks);
    if (company.energy > company.maxEnergyStorage) {
      violations.push(
        `${companyId}.energy=${company.energy} exceeds maxEnergyStorage=${company.maxEnergyStorage}`,
      );
    }

    for (const [itemId, stock] of Object.entries(company.inventory)) {
      checkCounter(violations, `${companyId}.inventory.${itemId}.available`, stock.available);
      checkCounter(violations, `${companyId}.inventory.${itemId}.reserved`, stock.reserved);
    }

    company.lines.forEach((line, lineIndex) => {
      const path = `${companyId}.lines[${lineIndex}]`;
      checkCounter(violations, `${path}.totalBatchesProduced`, line.totalBatchesProduced);
      checkCounter(violations, `${path}.lastActionTick`, line.lastActionTick);
      if (!line.activeBatch) {
        return;
      }
      const batch = line.activeBatch;
      checkCounter(violations, `${path}.activeBatch.progressTicks`, batch.progressTicks);
      checkCounter(violations, `${path}.activeBatch.completedBatches`, batch.completedBatches);
      checkCounter(violations, `${path}.activeBatch.targetBatches`, batch.targetBatches);
      checkCounter(violations, `${path}.activeBatch.energyPerTick`, batch.energyPerTick);
      checkCounter(violations, `${path}.activeBatch.energyRemainder`, batch.energyRemainder);
      if (batch.progressTicks > batch.totalDurationTicks) {
        violations.push(
          `${path}.activeBatch.progressTicks=${batch.progressTicks} > ${batch.totalDurationTicks}`,
        );
      }
      if (batch.completedBatches > batch.targetBatches) {
        violations.push(
          `${path}.activeBatch.completedBatches=${batch.completedBatches} > ${batch.targetBatches}`,
        );
      }
    });
  }

  for (const [contractId, contract] of Object.entries(snapshot.contracts)) {
    checkCounter(violations, `${contractId}.totalQuantity`, contract.totalQuantity);
    checkCounter(violations, `${contractId}.deliveredQuantity`, contract.deliveredQuantity);
    checkCounter(violations, `${contractId}.unitPriceCredits`, contract.unitPriceCredits);
    checkCounter(violations, `${contractId}.totalValueCredits`, contract.totalValueCredits);
    checkCounter(
      violations,
      `${contractId}.collateralSellerCredits`,
      contract.collateralSellerCredits,
    );
    checkCounter(violations, `${contractId}.penaltyPerMissingUnit`, contract.penaltyPerMissingUnit);
    if (contract.deliveredQuantity > contract.totalQuantity) {
      violations.push(
        `${contractId}.deliveredQuantity=${contract.deliveredQuantity} > totalQuantity=${contract.totalQuantity}`,
      );
    }
    if (contract.deadlineTick <= contract.createdAtTick) {
      violations.push(
        `${contractId}.deadlineTick=${contract.deadlineTick} <= createdAtTick=${contract.createdAtTick}`,
      );
    }
  }

  checkCounter(
    violations,
    'globalProject.deliveredMegamachineParts',
    snapshot.globalProject.deliveredMegamachineParts,
  );
  checkCounter(
    violations,
    'globalProject.requiredMegamachineParts',
    snapshot.globalProject.requiredMegamachineParts,
  );
  return violations;
}

/**
 * Counters the engine never decreases. Returns `path: before -> after` strings.
 */
export function collectMonotonicViolations(
  before: SimulationSnapshot,
  after: SimulationSnapshot,
): string[] {
  const violations: string[] = [];
  const regressions = (path: string, previous: number, next: number): void => {
    if (next < previous) {
      violations.push(`${path}: ${previous} -> ${next}`);
    }
  };

  if (after.tick !== before.tick + 1) {
    violations.push(`tick: ${before.tick} -> ${after.tick} (expected exactly +1)`);
  }
  regressions(
    'globalProject.deliveredMegamachineParts',
    before.globalProject.deliveredMegamachineParts,
    after.globalProject.deliveredMegamachineParts,
  );

  for (const [companyId, previous] of Object.entries(before.companies)) {
    const next = after.companies[companyId];
    if (!next) {
      violations.push(`companies.${companyId} disappeared`);
      continue;
    }
    regressions(
      `${companyId}.maintenancePaidTicks`,
      previous.maintenancePaidTicks,
      next.maintenancePaidTicks,
    );
    regressions(
      `${companyId}.installedTurbinesR7`,
      previous.installedTurbinesR7,
      next.installedTurbinesR7,
    );
    regressions(
      `${companyId}.contributedMegamachinePartsR8`,
      previous.contributedMegamachinePartsR8,
      next.contributedMegamachinePartsR8,
    );
    regressions(
      `${companyId}.maxEnergyStorage`,
      previous.maxEnergyStorage,
      next.maxEnergyStorage,
    );
    regressions(
      `${companyId}.energyGenerationPerTick`,
      previous.energyGenerationPerTick,
      next.energyGenerationPerTick,
    );

    for (const previousLine of previous.lines) {
      const nextLine = next.lines.find((line) => line.lineId === previousLine.lineId);
      if (!nextLine) {
        violations.push(`${companyId} line ${previousLine.lineId} disappeared`);
        continue;
      }
      regressions(
        `${companyId}.${previousLine.lineId}.totalBatchesProduced`,
        previousLine.totalBatchesProduced,
        nextLine.totalBatchesProduced,
      );
      regressions(
        `${companyId}.${previousLine.lineId}.lastActionTick`,
        previousLine.lastActionTick,
        nextLine.lastActionTick,
      );
    }
  }

  for (const [contractId, previous] of Object.entries(before.contracts)) {
    const next = after.contracts[contractId];
    if (!next) {
      violations.push(`contract ${contractId} disappeared`);
      continue;
    }
    regressions(
      `${contractId}.deliveredQuantity`,
      previous.deliveredQuantity,
      next.deliveredQuantity,
    );
  }
  return violations;
}

/* ------------------------------------------------------------------------- */
/* Scenario runner                                                            */
/* ------------------------------------------------------------------------- */

/** A command minus the base fields the scenario runner fills in itself. */
export type ScenarioCommandPayload = DistributiveOmit<
  GameCommand,
  'sequenceNumber' | 'commandId' | 'idempotencyKey' | 'scheduledTick'
>;

export interface CommandContext {
  /** Enqueue `payload` so it executes on the next processed tick. */
  submit(payload: ScenarioCommandPayload): void;
}

export interface ScenarioStep {
  readonly atTick: number;
  readonly label: string;
  readonly apply: (engine: SimulatorEngine, context: CommandContext) => void;
}

export interface PropertyScenario {
  readonly seed: number;
  readonly label: string;
  readonly totalTicks: number;
  readonly contractsEnabled: boolean;
  readonly prepare: (engine: SimulatorEngine) => void;
  readonly steps: readonly ScenarioStep[];
}

export interface ScenarioHooks {
  readonly onStart?: (engine: SimulatorEngine) => void;
  readonly onTickEnd?: (
    engine: SimulatorEngine,
    tick: number,
    before: SimulationSnapshot,
    after: SimulationSnapshot,
  ) => void;
}

interface ScenarioInput {
  readonly seed: number;
  readonly label: string;
  readonly totalTicks: number;
  readonly contractsEnabled?: boolean;
  readonly prepare?: (engine: SimulatorEngine) => void;
  readonly steps: readonly ScenarioStep[];
}

export function createScenario(input: ScenarioInput): PropertyScenario {
  return {
    seed: input.seed,
    label: input.label,
    totalTicks: input.totalTicks,
    contractsEnabled: input.contractsEnabled ?? false,
    prepare: input.prepare ?? (() => undefined),
    steps: input.steps,
  };
}

function createCommandContext(seed: number, engine: SimulatorEngine): CommandContext {
  let counter = 0;
  return {
    submit(payload: ScenarioCommandPayload): void {
      counter += 1;
      const accepted = engine.submitCommand({
        ...payload,
        commandId: `prop_s${seed}_cmd_${counter}`,
        idempotencyKey: `prop_s${seed}_idem_${counter}`,
        scheduledTick: engine.getCurrentTick() + 1,
      });
      if (!accepted) {
        throw new Error(`[property] seed ${seed}: command ${payload.type} was rejected by the queue`);
      }
    },
  };
}

/**
 * Apply the scenario's setup, run the scripted steps tick by tick and call
 * `onTickEnd` after every processed tick with settled before/after snapshots.
 */
export function runScenario(scenario: PropertyScenario, hooks: ScenarioHooks = {}): SimulatorEngine {
  const engine = new SimulatorEngine(scenario.seed);
  engine.initializeStandardMatch();
  scenario.prepare(engine);
  hooks.onStart?.(engine);

  const context = createCommandContext(scenario.seed, engine);
  const steps = [...scenario.steps].sort((a, b) => a.atTick - b.atTick);
  let pendingStepIndex = 0;

  for (let tick = 1; tick <= scenario.totalTicks; tick += 1) {
    while (pendingStepIndex < steps.length && steps[pendingStepIndex].atTick <= tick) {
      steps[pendingStepIndex].apply(engine, context);
      pendingStepIndex += 1;
    }
    const before = engine.createSnapshot();
    const after = engine.processTick();
    hooks.onTickEnd?.(engine, tick, before, after);
  }

  if (pendingStepIndex < steps.length) {
    throw new Error(
      `[property] seed ${scenario.seed}: step "${steps[pendingStepIndex].label}" is scheduled at tick ${steps[pendingStepIndex].atTick}, past the ${scenario.totalTicks}-tick budget`,
    );
  }
  return engine;
}

/* ------------------------------------------------------------------------- */
/* Step and setup builders                                                    */
/* ------------------------------------------------------------------------- */

export function lineId(companyId: string, lineNumber: number): string {
  return `${companyId}_line_${lineNumber}`;
}

/** Add starting inventory, exactly like the reference engine test does. */
export function injectInventory(
  engine: SimulatorEngine,
  companyId: string,
  itemId: ItemId,
  quantity: number,
): void {
  const company = engine.getCompany(companyId);
  if (!company) {
    throw new Error(`[property] unknown company ${companyId}`);
  }
  company.inventory[itemId].available += quantity;
}

/** Shrink the battery so extraction throttling becomes reachable in a short run. */
export function constrainEnergyStorage(
  engine: SimulatorEngine,
  companyId: string,
  maxEnergyStorage: number,
): void {
  const company = engine.getCompany(companyId);
  if (!company) {
    throw new Error(`[property] unknown company ${companyId}`);
  }
  company.maxEnergyStorage = maxEnergyStorage;
  company.energy = Math.min(company.energy, maxEnergyStorage);
}

export function setProductionStep(
  companyId: string,
  lineNumber: number,
  recipeId: RecipeId,
  targetBatches: number,
  atTick: number,
): ScenarioStep {
  return {
    atTick,
    label: `${companyId} line ${lineNumber} -> ${recipeId} x${targetBatches}`,
    apply(_engine, context) {
      context.submit({
        type: 'SET_PRODUCTION_TARGET',
        companyId,
        lineId: lineId(companyId, lineNumber),
        recipeId,
        targetBatches,
      });
    },
  };
}

export function priorityStep(
  companyId: string,
  lineNumber: number,
  priority: LinePriority,
  atTick: number,
): ScenarioStep {
  return {
    atTick,
    label: `${companyId} line ${lineNumber} priority ${priority}`,
    apply(_engine, context) {
      context.submit({
        type: 'SET_LINE_PRIORITY',
        companyId,
        lineId: lineId(companyId, lineNumber),
        priority,
      });
    },
  };
}

export function pauseStep(companyId: string, lineNumber: number, atTick: number): ScenarioStep {
  return {
    atTick,
    label: `pause ${companyId} line ${lineNumber}`,
    apply(_engine, context) {
      context.submit({
        type: 'PAUSE_PRODUCTION_LINE',
        companyId,
        lineId: lineId(companyId, lineNumber),
      });
    },
  };
}

export function resumeStep(companyId: string, lineNumber: number, atTick: number): ScenarioStep {
  return {
    atTick,
    label: `resume ${companyId} line ${lineNumber}`,
    apply(_engine, context) {
      context.submit({
        type: 'RESUME_PRODUCTION_LINE',
        companyId,
        lineId: lineId(companyId, lineNumber),
      });
    },
  };
}

export function deliverPartsStep(companyId: string, quantity: number, atTick: number): ScenarioStep {
  return {
    atTick,
    label: `${companyId} delivers ${quantity} megamachine part(s)`,
    apply(_engine, context) {
      context.submit({ type: 'DELIVER_MEGAMACHINE_PART', companyId, quantity });
    },
  };
}

export function installTurbineStep(companyId: string, atTick: number): ScenarioStep {
  return {
    atTick,
    label: `${companyId} installs a turbine expansion`,
    apply(_engine, context) {
      context.submit({ type: 'INSTALL_TURBINE_EXPANSION', companyId });
    },
  };
}

/**
 * Resolve the contract a step should act on. Contracts are created in a
 * deterministic order and never removed, so the newest matching contract is a
 * stable choice for scripted scenarios.
 */
export function latestContractId(
  engine: SimulatorEngine,
  predicate: (contract: { sellerCompanyId: string; status: string }) => boolean,
): string {
  const matches = engine.getAllContracts().filter((contract) =>
    predicate({ sellerCompanyId: contract.sellerCompanyId, status: contract.status }),
  );
  const latest = matches[matches.length - 1];
  if (!latest) {
    throw new Error('[property] no contract matches the scenario step');
  }
  return latest.contractId;
}

export function createOfferStep(input: {
  readonly sellerCompanyId: string;
  readonly buyerCompanyId?: string;
  readonly itemId: ItemId;
  readonly quantity: number;
  readonly unitPriceCredits: number;
  readonly deadlineTick: number;
  readonly atTick: number;
}): ScenarioStep {
  return {
    atTick: input.atTick,
    label: `${input.sellerCompanyId} offers ${input.quantity} ${input.itemId} @ ${input.unitPriceCredits}`,
    apply(_engine, context) {
      context.submit({
        type: 'CREATE_SUPPLY_OFFER',
        companyId: input.sellerCompanyId,
        ...(input.buyerCompanyId === undefined ? {} : { targetBuyerId: input.buyerCompanyId }),
        itemId: input.itemId,
        quantity: input.quantity,
        unitPriceCredits: input.unitPriceCredits,
        deadlineTicks: input.deadlineTick,
      });
    },
  };
}

export function acceptOfferStep(input: {
  readonly sellerCompanyId: string;
  readonly buyerCompanyId: string;
  readonly atTick: number;
}): ScenarioStep {
  return {
    atTick: input.atTick,
    label: `${input.buyerCompanyId} accepts the offer of ${input.sellerCompanyId}`,
    apply(engine, context) {
      const contractId = latestContractId(
        engine,
        (contract) => contract.sellerCompanyId === input.sellerCompanyId && contract.status === 'PENDING',
      );
      context.submit({
        type: 'ACCEPT_SUPPLY_OFFER',
        companyId: input.buyerCompanyId,
        contractId,
      });
    },
  };
}

export function shipStep(input: {
  readonly sellerCompanyId: string;
  readonly quantity: number;
  readonly atTick: number;
}): ScenarioStep {
  return {
    atTick: input.atTick,
    label: `${input.sellerCompanyId} ships ${input.quantity} unit(s)`,
    apply(engine, context) {
      const contractId = latestContractId(
        engine,
        (contract) => contract.sellerCompanyId === input.sellerCompanyId && contract.status === 'ACTIVE',
      );
      context.submit({
        type: 'SCHEDULE_INTERNAL_TRANSPORT',
        companyId: input.sellerCompanyId,
        contractId,
        quantityToShip: input.quantity,
      });
    },
  };
}

export function cancelOfferStep(sellerCompanyId: string, atTick: number): ScenarioStep {
  return {
    atTick,
    label: `${sellerCompanyId} cancels its pending offer`,
    apply(engine, context) {
      const contractId = latestContractId(
        engine,
        (contract) => contract.sellerCompanyId === sellerCompanyId && contract.status === 'PENDING',
      );
      context.submit({
        type: 'CANCEL_PENDING_OFFER',
        companyId: sellerCompanyId,
        contractId,
      });
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Fixed seed corpus                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The FIXED seed corpus (spec S3). Every seed is a literal constant and every
 * scenario is an explicit command/tick script; nothing is derived from the clock
 * or from an unseeded generator. The setups vary company, industrial class,
 * recipe depth, energy headroom, contract activity and sunk-material paths.
 */
export function buildScenarioCorpus(): PropertyScenario[] {
  return [
    createScenario({
      seed: 42107, // engine default seed
      label: 'default match: R1 ingots on class A and class B lines',
      totalTicks: 320,
      steps: [
        setProductionStep(METAL_A, 1, 'R1', 3, 1),
        setProductionStep(MANUF_A, 1, 'R1', 2, 1),
      ],
    }),
    createScenario({
      seed: 1,
      label: 'R2 steel from injected ingots with an exact input budget',
      totalTicks: 180,
      prepare: (engine) => {
        injectInventory(engine, METAL_B, 'IRON_INGOT', 8);
        injectInventory(engine, MANUF_B, 'IRON_INGOT', 4);
      },
      steps: [
        setProductionStep(METAL_B, 1, 'R2', 2, 1),
        setProductionStep(MANUF_B, 2, 'R2', 1, 5),
      ],
    }),
    createScenario({
      seed: 7,
      label: 'R3 heavy alloy on class A plus R4 frames on class B',
      totalTicks: 240,
      prepare: (engine) => {
        injectInventory(engine, METAL_A, 'STEEL_PLATE', 8);
        injectInventory(engine, MANUF_A, 'STEEL_PLATE', 8);
        injectInventory(engine, MANUF_A, 'IRON_INGOT', 4);
      },
      steps: [
        setProductionStep(METAL_A, 2, 'R3', 2, 1),
        setProductionStep(MANUF_A, 3, 'R4', 2, 10),
      ],
    }),
    createScenario({
      seed: 13,
      label: 'R5 circuits on both classes with mid-run priority swaps',
      totalTicks: 240,
      prepare: (engine) => {
        injectInventory(engine, METAL_A, 'IRON_INGOT', 4);
        injectInventory(engine, MANUF_A, 'IRON_INGOT', 4);
      },
      steps: [
        setProductionStep(METAL_A, 1, 'R5', 2, 1),
        setProductionStep(MANUF_A, 1, 'R5', 2, 1),
        priorityStep(METAL_A, 1, 3, 30),
        priorityStep(METAL_A, 1, 1, 60),
      ],
    }),
    createScenario({
      seed: 42,
      label: 'R7 turbines paused and resumed while a batch holds work in progress',
      totalTicks: 300,
      prepare: (engine) => {
        injectInventory(engine, METAL_A, 'POWER_MODULE', 4);
        injectInventory(engine, METAL_A, 'HEAVY_ALLOY', 8);
      },
      steps: [
        setProductionStep(METAL_A, 1, 'R7', 2, 1),
        pauseStep(METAL_A, 1, 20),
        resumeStep(METAL_A, 1, 40),
      ],
    }),
    createScenario({
      seed: 99,
      label: 'R8 megamachine part produced and delivered to the global project',
      totalTicks: 120,
      prepare: (engine) => {
        injectInventory(engine, MANUF_B, 'IND_TURBINE', 2);
        injectInventory(engine, MANUF_B, 'MECH_FRAME', 4);
        injectInventory(engine, MANUF_B, 'STEEL_PLATE', 4);
      },
      steps: [setProductionStep(MANUF_B, 1, 'R8', 1, 1), deliverPartsStep(MANUF_B, 1, 80)],
    }),
    createScenario({
      seed: 256,
      label: 'capped battery throttles raw ore extraction',
      totalTicks: 320,
      prepare: (engine) => {
        injectInventory(engine, MANUF_B, 'IRON_INGOT', 18);
        constrainEnergyStorage(engine, MANUF_B, 20);
      },
      steps: [
        setProductionStep(MANUF_B, 1, 'R5', 3, 1),
        setProductionStep(MANUF_B, 2, 'R5', 3, 1),
        setProductionStep(MANUF_B, 3, 'R5', 3, 1),
      ],
    }),
    createScenario({
      seed: 777,
      label: 'open offer accepted by a real buyer, then partly shipped',
      totalTicks: 180,
      contractsEnabled: true,
      steps: [
        createOfferStep({
          sellerCompanyId: METAL_A,
          itemId: 'RAW_ORE',
          quantity: 60,
          unitPriceCredits: 5,
          deadlineTick: 200,
          atTick: 10,
        }),
        acceptOfferStep({ sellerCompanyId: METAL_A, buyerCompanyId: MANUF_A, atTick: 20 }),
        shipStep({ sellerCompanyId: METAL_A, quantity: 20, atTick: 30 }),
      ],
    }),
    createScenario({
      seed: 1234,
      label: 'contract fulfilled by two shipments settles escrow minus the market fee',
      totalTicks: 180,
      contractsEnabled: true,
      steps: [
        createOfferStep({
          sellerCompanyId: METAL_B,
          buyerCompanyId: MANUF_B,
          itemId: 'RAW_ORE',
          quantity: 40,
          unitPriceCredits: 10,
          deadlineTick: 170,
          atTick: 5,
        }),
        acceptOfferStep({ sellerCompanyId: METAL_B, buyerCompanyId: MANUF_B, atTick: 10 }),
        shipStep({ sellerCompanyId: METAL_B, quantity: 25, atTick: 20 }),
        shipStep({ sellerCompanyId: METAL_B, quantity: 15, atTick: 30 }),
      ],
    }),
    createScenario({
      seed: 4096,
      label: 'turbine expansion after the tick-900 unlock adds a fourth line',
      totalTicks: 920,
      prepare: (engine) => {
        injectInventory(engine, METAL_A, 'IND_TURBINE', 1);
      },
      steps: [setProductionStep(METAL_A, 1, 'R1', 4, 1), installTurbineStep(METAL_A, 900)],
    }),
    createScenario({
      seed: 31337,
      label: 'mixed recipes on all four companies under one shared energy budget',
      totalTicks: 300,
      prepare: (engine) => {
        injectInventory(engine, MANUF_A, 'MECH_FRAME', 2);
        injectInventory(engine, MANUF_A, 'CTRL_CIRCUIT', 2);
        injectInventory(engine, MANUF_A, 'HEAVY_ALLOY', 2);
        injectInventory(engine, METAL_A, 'IRON_INGOT', 8);
        injectInventory(engine, MANUF_B, 'STEEL_PLATE', 8);
        injectInventory(engine, MANUF_B, 'IRON_INGOT', 4);
      },
      steps: [
        setProductionStep(MANUF_A, 1, 'R6', 1, 1),
        setProductionStep(METAL_A, 1, 'R2', 2, 1),
        setProductionStep(METAL_B, 1, 'R1', 2, 20),
        setProductionStep(MANUF_B, 1, 'R4', 2, 30),
      ],
    }),
    createScenario({
      seed: 65535,
      label: 'offer created and cancelled before acceptance moves no credits',
      totalTicks: 120,
      contractsEnabled: true,
      steps: [
        createOfferStep({
          sellerCompanyId: METAL_A,
          itemId: 'RAW_ORE',
          quantity: 10,
          unitPriceCredits: 3,
          deadlineTick: 100,
          atTick: 10,
        }),
        cancelOfferStep(METAL_A, 20),
      ],
    }),
  ];
}

/** Every literal seed of the corpus, in corpus order. */
export function corpusSeeds(): number[] {
  return buildScenarioCorpus().map((scenario) => scenario.seed);
}
