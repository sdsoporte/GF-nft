/**
 * GigaForge v4.1 - NPC Controller
 * Orchestrates deterministic NPC participants within an active match with approved product settings.
 */

import { EnqueueCommandInput, RecipeId, SimulationSnapshot } from '../../domain/types.ts';
import { Mulberry32PRNG, SimulatorEngine } from '../SimulatorEngine.ts';
import { DeterministicNpcPolicy } from './DeterministicNpcPolicy.ts';
import {
  computeTargetBufferFromInitialStock,
  DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT,
  DEFAULT_NPC_SELL_MARGIN_PERCENT,
  DEFAULT_STARTING_STOCK,
  NpcCompanyConfig,
} from './types.ts';

/** Issue #55: NPC randomness derives from (match seed, tick), so decisions are a
 * pure function of match state + tick — replay, restart and rollback reproduce
 * them exactly with no controller state to persist. */
export function deriveNpcTickSeed(baseSeed: number, tick: number): number {
  return (baseSeed ^ Math.imul(tick + 1, 0x9e3779b1)) >>> 0;
}

export const DEFAULT_NPC_CONFIG_CLASS_A: NpcCompanyConfig = Object.freeze({
  companyId: 'comp_metal_02',
  targetBuffer: Object.freeze(computeTargetBufferFromInitialStock(DEFAULT_STARTING_STOCK)),
  preferredRecipes: Object.freeze<RecipeId[]>(['R1', 'R2', 'R3']),
  priceMarginPercent: DEFAULT_NPC_SELL_MARGIN_PERCENT,
  maxBuyPriceMarginPercent: DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT,
  offerBatchSizes: Object.freeze({
    IRON_INGOT: 5,
    STEEL_PLATE: 4,
    HEAVY_ALLOY: 2,
  }),
  offerDurationTicks: 300,
  minCreditReserve: 500,
  autoInstallTurbine: true,
  maxActiveOffers: 3,
});

export const DEFAULT_NPC_CONFIG_CLASS_B: NpcCompanyConfig = Object.freeze({
  companyId: 'comp_manuf_02',
  targetBuffer: Object.freeze(computeTargetBufferFromInitialStock(DEFAULT_STARTING_STOCK)),
  preferredRecipes: Object.freeze<RecipeId[]>(['R4', 'R5', 'R6', 'R7']),
  priceMarginPercent: DEFAULT_NPC_SELL_MARGIN_PERCENT,
  maxBuyPriceMarginPercent: DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT,
  offerBatchSizes: Object.freeze({
    MECH_FRAME: 2,
    CTRL_CIRCUIT: 2,
    POWER_MODULE: 1,
    IND_TURBINE: 1,
  }),
  offerDurationTicks: 300,
  minCreditReserve: 500,
  autoInstallTurbine: true,
  maxActiveOffers: 3,
});

export interface NpcControllerOptions {
  readonly seed?: number;
  readonly configs?: readonly NpcCompanyConfig[];
}

export class NpcController {
  private readonly baseSeed: number;
  private readonly policies: Map<string, DeterministicNpcPolicy> = new Map();

  constructor(options: NpcControllerOptions = {}) {
    this.baseSeed = options.seed ?? 42107;
    const configs = options.configs ?? [DEFAULT_NPC_CONFIG_CLASS_A, DEFAULT_NPC_CONFIG_CLASS_B];
    for (const config of configs) {
      this.policies.set(config.companyId, new DeterministicNpcPolicy(config));
    }
  }

  public getRegisteredCompanyIds(): string[] {
    return Array.from(this.policies.keys());
  }

  public getPolicy(companyId: string): DeterministicNpcPolicy | undefined {
    return this.policies.get(companyId);
  }

  /**
   * Evaluate all registered NPCs and submit their decisions to the engine.
   * Returns all enqueued commands.
   */
  public stepTick(engine: SimulatorEngine): EnqueueCommandInput[] {
    const allSubmitted: EnqueueCommandInput[] = [];
    const currentTick = engine.getCurrentTick();
    const contracts = engine.getAllContracts();

    for (const [companyId, policy] of this.policies.entries()) {
      const company = engine.getCompany(companyId);
      if (!company || !company.isNPC) continue;

      const decisions = policy.evaluateDecisions(company, contracts, currentTick, new Mulberry32PRNG(deriveNpcTickSeed(this.baseSeed, currentTick)));
      for (const cmd of decisions) {
        const enqueued = engine.submitCommand(cmd);
        if (enqueued) {
          allSubmitted.push(cmd);
        }
      }
    }

    return allSubmitted;
  }

  /**
   * Run one complete tick: evaluate NPCs, enqueue commands, then advance engine tick.
   * Returns the resulting snapshot and commands.
   */
  public stepAndTick(engine: SimulatorEngine): EnqueueCommandInput[] {
    const submitted = this.stepTick(engine);
    engine.processTick();
    return submitted;
  }
}
