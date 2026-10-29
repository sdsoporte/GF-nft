/**
 * GigaForge v4.1 - NPC System Domain Types
 * Deterministic types and approved product configurations for autonomous NPC market providers.
 */

import { ItemId, RecipeId } from '../../domain/types.ts';

/**
 * Approved Product Decision (Issue #13 - Decision 1):
 * Selling price margin for NPCs is fixed at 20% (1.20× base unit cost).
 * This covers the 20% seller collateral lock and the 2% market burn fee,
 * ensuring consistent capital accumulation while offering competitive pricing.
 */
export const DEFAULT_NPC_SELL_MARGIN_PERCENT = 20;

/**
 * Approved Product Decision (Issue #13 - Decision 2):
 * NPCs retain exactly 50% of their initial starting stock per item before releasing
 * surplus to market offers.
 */
export const NPC_INITIAL_STOCK_RETENTION_RATIO = 0.5;

/**
 * Standard starting stock per company as defined in SimulatorEngine and GAME_DESIGN_MVP.
 */
export const DEFAULT_STARTING_STOCK: Readonly<Record<ItemId, number>> = Object.freeze({
  RAW_ORE: 200,
  IRON_INGOT: 0,
  STEEL_PLATE: 0,
  HEAVY_ALLOY: 0,
  MECH_FRAME: 0,
  CTRL_CIRCUIT: 0,
  POWER_MODULE: 0,
  IND_TURBINE: 0,
  MEGAMACHINE_PART: 0,
});

/**
 * Approved Product Decision (Issue #13 - Decision 3):
 * NPC buyers will pay at most 1.0× recipe base cost (0% margin over base cost).
 * Any offer priced above base cost is rejected by NPC buyers.
 */
export const DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT = 0;

/**
 * Approved Product Decision (Issue #13 - Decision 4):
 * Base energy generation remains +20 ENERGY/tick in the engine.
 */
export const BASE_ENERGY_GENERATION_PER_TICK = 20;

/**
 * Computes the target buffer based on initial stock and retention ratio (50%).
 */
export function computeTargetBufferFromInitialStock(
  startingStock: Partial<Record<ItemId, number>> = DEFAULT_STARTING_STOCK,
  retentionRatio: number = NPC_INITIAL_STOCK_RETENTION_RATIO
): InventoryTargetBuffer {
  const buffer: InventoryTargetBuffer = {};
  for (const [key, qty] of Object.entries(startingStock)) {
    const itemId = key as ItemId;
    if (qty !== undefined && qty > 0) {
      buffer[itemId] = Math.floor(qty * retentionRatio);
    } else {
      buffer[itemId] = 0;
    }
  }
  return buffer;
}

/**
 * Inventory target buffer per item: quantity to keep before considering surplus.
 */
export type InventoryTargetBuffer = Partial<Record<ItemId, number>>;

/**
 * Standard batch size per item when posting supply offers.
 */
export type OfferBatchSizes = Partial<Record<ItemId, number>>;

/**
 * Configuration parameters for an autonomous NPC company.
 */
export interface NpcCompanyConfig {
  readonly companyId: string;
  /** Buffer quantity of each item reserved for internal production/survival (50% of initial stock) */
  readonly targetBuffer: InventoryTargetBuffer;
  /** Primary specialized recipes this NPC prioritizes */
  readonly preferredRecipes: readonly RecipeId[];
  /** Percentage margin added to base recipe cost for open market offers (fixed at 20%) */
  readonly priceMarginPercent: number;
  /** Maximum price margin percent this NPC is willing to pay when buying inputs (0% = at most 1.0x base cost) */
  readonly maxBuyPriceMarginPercent: number;
  /** Standard quantity offered per contract */
  readonly offerBatchSizes: OfferBatchSizes;
  /** Duration in ticks for contract offers */
  readonly offerDurationTicks: number;
  /** Minimum credits kept untouched for maintenance and collateral */
  readonly minCreditReserve: number;
  /** Whether to automatically install R7 turbines at tick >= 900 */
  readonly autoInstallTurbine: boolean;
  /** Maximum active draft or pending offers allowed simultaneously */
  readonly maxActiveOffers: number;
}

/**
 * Snapshot metrics evaluating energy balance and utilization over time.
 */
export interface EnergyBalanceMetrics {
  readonly companyId: string;
  readonly industrialClass: string;
  readonly startingEnergy: number;
  readonly endingEnergy: number;
  readonly minEnergyObserved: number;
  readonly maxEnergyObserved: number;
  readonly averageEnergy: number;
  readonly totalTicksSimulated: number;
  readonly starvedTicksCount: number;
  readonly installedTurbinesR7: number;
  readonly totalBatchesProduced: number;
  readonly totalContractsFulfilled: number;
}
