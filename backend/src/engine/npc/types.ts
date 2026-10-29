/**
 * GigaForge v4.1 - NPC System Domain Types
 * Deterministic types and configurations for autonomous NPC market providers.
 */

import { ItemId, RecipeId } from '../../domain/types.ts';

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
  /** Buffer quantity of each item reserved for internal production/survival */
  readonly targetBuffer: InventoryTargetBuffer;
  /** Primary specialized recipes this NPC prioritizes */
  readonly preferredRecipes: readonly RecipeId[];
  /** Percentage margin added to base recipe cost for open market offers */
  readonly priceMarginPercent: number;
  /** Maximum price margin percent this NPC is willing to pay when buying inputs */
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
