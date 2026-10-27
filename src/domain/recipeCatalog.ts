/**
 * GigaForge v4.1 - Production Recipe Catalog
 * Immutable specifications for all 8 MVP recipes (R1 to R8) and Base Extraction.
 * Pure integer arithmetic guarantees deterministic execution.
 */

import {
  IndustrialClass,
  ItemId,
  RecipeDefinition,
  RecipeId,
  RecipeProfile,
  RawOreExtractionSpec,
} from './types.ts';

/**
 * Strict integer assertion helper to prevent floating point pollution.
 */
export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `[GigaForge Domain Error] Value for "${label}" must be a safe integer, received: ${value}`
    );
  }
}

/**
 * Industrial classes enumeration constants
 */
export const INDUSTRIAL_CLASSES = {
  CLASS_A_METALLURGY: 'CLASS_A_METALLURGY',
  CLASS_B_MANUFACTURING: 'CLASS_B_MANUFACTURING',
} as const satisfies Record<string, IndustrialClass>;

/**
 * Item ID enumeration constants
 */
export const ITEM_IDS = {
  RAW_ORE: 'RAW_ORE',
  IRON_INGOT: 'IRON_INGOT',
  STEEL_PLATE: 'STEEL_PLATE',
  HEAVY_ALLOY: 'HEAVY_ALLOY',
  MECH_FRAME: 'MECH_FRAME',
  CTRL_CIRCUIT: 'CTRL_CIRCUIT',
  POWER_MODULE: 'POWER_MODULE',
  IND_TURBINE: 'IND_TURBINE',
  MEGAMACHINE_PART: 'MEGAMACHINE_PART',
} as const satisfies Record<string, ItemId>;

/**
 * Base raw ore extraction profile
 * 1 extraction cycle produces 5 RAW_ORE every 10 ticks consuming 15 ENERGY
 */
export const RAW_ORE_EXTRACTION: RawOreExtractionSpec = Object.freeze({
  ticksPerCycle: 10,
  outputQuantity: 5,
  energyCostPerCycle: 15,
});

/**
 * Master catalog of recipes R1 through R8
 * Exactly matching GAME_DESIGN_MVP.md
 */
export const RECIPE_CATALOG: Readonly<Record<RecipeId, RecipeDefinition>> = Object.freeze({
  R1: Object.freeze({
    id: 'R1',
    name: 'Lingote de Hierro (IRON_INGOT)',
    outputItem: 'IRON_INGOT',
    outputQuantity: 5,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'RAW_ORE', quantity: 10 }),
    ]),
    classA: Object.freeze({
      durationTicks: 10, // Óptimo
      energyCost: 20,
    }),
    classB: Object.freeze({
      durationTicks: 20, // Penalizado (+100% time)
      energyCost: 40,   // Penalizado (+100% energy)
    }),
    estimatedBaseCostCredits: 50,
  }),

  R2: Object.freeze({
    id: 'R2',
    name: 'Placa de Acero (STEEL_PLATE)',
    outputItem: 'STEEL_PLATE',
    outputQuantity: 4,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'IRON_INGOT', quantity: 4 }),
      Object.freeze({ itemId: 'RAW_ORE', quantity: 5 }),
    ]),
    classA: Object.freeze({
      durationTicks: 15, // Óptimo
      energyCost: 35,
    }),
    classB: Object.freeze({
      durationTicks: 30, // Penalizado (+100% time)
      energyCost: 70,   // Penalizado (+100% energy)
    }),
    estimatedBaseCostCredits: 120,
  }),

  R3: Object.freeze({
    id: 'R3',
    name: 'Aleación Pesada (HEAVY_ALLOY)',
    outputItem: 'HEAVY_ALLOY',
    outputQuantity: 2,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'STEEL_PLATE', quantity: 4 }),
      Object.freeze({ itemId: 'RAW_ORE', quantity: 10 }),
    ]),
    classA: Object.freeze({
      durationTicks: 25, // Óptimo
      energyCost: 60,
    }),
    classB: Object.freeze({
      durationTicks: 55, // Penalizado (+120% time)
      energyCost: 120,  // Penalizado (+100% energy)
    }),
    estimatedBaseCostCredits: 320,
  }),

  R4: Object.freeze({
    id: 'R4',
    name: 'Bastidor Mecánico (MECH_FRAME)',
    outputItem: 'MECH_FRAME',
    outputQuantity: 2,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'STEEL_PLATE', quantity: 4 }),
      Object.freeze({ itemId: 'IRON_INGOT', quantity: 2 }),
    ]),
    classA: Object.freeze({
      durationTicks: 30, // Penalizado (+100% time)
      energyCost: 60,   // Penalizado (+100% energy)
    }),
    classB: Object.freeze({
      durationTicks: 15, // Óptimo
      energyCost: 30,
    }),
    estimatedBaseCostCredits: 220,
  }),

  R5: Object.freeze({
    id: 'R5',
    name: 'Circuito de Control (CTRL_CIRCUIT)',
    outputItem: 'CTRL_CIRCUIT',
    outputQuantity: 2,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'IRON_INGOT', quantity: 2 }),
      Object.freeze({ itemId: 'RAW_ORE', quantity: 6 }),
    ]),
    classA: Object.freeze({
      durationTicks: 40, // Penalizado (+100% time)
      energyCost: 80,   // Penalizado (+128% energy)
    }),
    classB: Object.freeze({
      durationTicks: 20, // Óptimo
      energyCost: 35,
    }),
    estimatedBaseCostCredits: 160,
  }),

  R6: Object.freeze({
    id: 'R6',
    name: 'Módulo de Energía (POWER_MODULE)',
    outputItem: 'POWER_MODULE',
    outputQuantity: 1,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'MECH_FRAME', quantity: 2 }),
      Object.freeze({ itemId: 'CTRL_CIRCUIT', quantity: 2 }),
      Object.freeze({ itemId: 'HEAVY_ALLOY', quantity: 2 }),
    ]),
    classA: Object.freeze({
      durationTicks: 50, // Penalizado (+100% time)
      energyCost: 110,  // Penalizado (+120% energy)
    }),
    classB: Object.freeze({
      durationTicks: 25, // Óptimo
      energyCost: 50,
    }),
    estimatedBaseCostCredits: 650,
  }),

  R7: Object.freeze({
    id: 'R7',
    name: 'Turbina Industrial (IND_TURBINE)',
    outputItem: 'IND_TURBINE',
    outputQuantity: 1,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'POWER_MODULE', quantity: 2 }),
      Object.freeze({ itemId: 'HEAVY_ALLOY', quantity: 4 }),
    ]),
    classA: Object.freeze({
      durationTicks: 40, // Neutral
      energyCost: 90,
    }),
    classB: Object.freeze({
      durationTicks: 40, // Neutral
      energyCost: 90,
    }),
    estimatedBaseCostCredits: 2200,
  }),

  R8: Object.freeze({
    id: 'R8',
    name: 'Sección Megamáquina (MEGAMACHINE_PART)',
    outputItem: 'MEGAMACHINE_PART',
    outputQuantity: 1,
    inputs: Object.freeze([
      Object.freeze({ itemId: 'IND_TURBINE', quantity: 2 }),
      Object.freeze({ itemId: 'MECH_FRAME', quantity: 4 }),
      Object.freeze({ itemId: 'STEEL_PLATE', quantity: 4 }),
    ]),
    classA: Object.freeze({
      durationTicks: 60, // Neutral
      energyCost: 150,
    }),
    classB: Object.freeze({
      durationTicks: 60, // Neutral
      energyCost: 150,
    }),
    estimatedBaseCostCredits: 5500,
  }),
});

/**
 * Validate recipe ID
 */
export function isRecipeId(id: string): id is RecipeId {
  return id in RECIPE_CATALOG;
}

/**
 * Retrieve recipe definition
 */
export function getRecipe(recipeId: RecipeId): RecipeDefinition {
  const recipe = RECIPE_CATALOG[recipeId];
  if (!recipe) {
    throw new Error(`[GigaForge RecipeCatalog] Unknown recipe id: ${recipeId}`);
  }
  return recipe;
}

/**
 * Retrieve profile (duration + energy) tailored to company industrial class
 */
export function getRecipeProfile(
  recipeId: RecipeId,
  industrialClass: IndustrialClass
): RecipeProfile {
  const recipe = getRecipe(recipeId);
  return industrialClass === 'CLASS_A_METALLURGY' ? recipe.classA : recipe.classB;
}

/**
 * Calculate logistical transport energy cost for contracts
 * Class A pays 2 ENERGY per shipped lot; Class B has automated logistics (0 ENERGY).
 */
export function getTransportEnergyCost(
  senderClass: IndustrialClass,
  _quantity: number
): number {
  return senderClass === 'CLASS_A_METALLURGY' ? 2 : 0;
}

/**
 * Compute integer division and remainder for deterministic energy distribution per tick
 */
export function calculateEnergyPerTick(
  totalEnergy: number,
  durationTicks: number
): { energyPerTick: number; energyRemainder: number } {
  assertSafeInteger(totalEnergy, 'totalEnergy');
  assertSafeInteger(durationTicks, 'durationTicks');
  if (durationTicks <= 0) {
    throw new Error(`[GigaForge] Duration ticks must be positive integer`);
  }
  const energyPerTick = Math.floor(totalEnergy / durationTicks);
  const energyRemainder = totalEnergy % durationTicks;
  return { energyPerTick, energyRemainder };
}
