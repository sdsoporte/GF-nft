/**
 * GigaForge v4.1 - Balance and Energy Evaluation Module
 * Analyzes economic cycles, energy utilization, and R7 turbine ROI over 2,700 ticks.
 */

import { CompanyState, IndustrialClass, ItemId, RecipeId } from '../../domain/types.ts';
import { getRecipe } from '../../domain/recipeCatalog.ts';
import { SimulatorEngine } from '../SimulatorEngine.ts';
import { NpcController } from './NpcController.ts';
import { EnergyBalanceMetrics } from './types.ts';

export interface CompanyTickRecord {
  energy: number;
  credits: number;
  starvedLinesCount: number;
  activeLinesCount: number;
}

export interface SimulationEvaluationResult {
  readonly totalTicks: number;
  readonly seed: number;
  readonly companyMetrics: Record<string, EnergyBalanceMetrics>;
  readonly tradeMetrics: {
    totalOffersPosted: number;
    totalContractsAccepted: number;
    totalContractsFulfilled: number;
    totalCreditsTransferred: number;
    totalMarketFeesBurned: number;
  };
  readonly globalMegamachineParts: number;
  readonly finalNetWorth: Record<string, number>;
}

export class BalanceEvaluationRunner {
  /**
   * Run a complete deterministic match of N ticks (default 2,700) and collect metrics.
   */
  public runSimulation(
    seed: number = 42107,
    ticks: number = 2700,
    npcController?: NpcController
  ): SimulationEvaluationResult {
    const engine = new SimulatorEngine(seed);
    engine.initializeStandardMatch();

    const controller = npcController ?? new NpcController({ seed });

    // Energy tracking accumulators per company
    const energySums: Record<string, number> = {};
    const minEnergyObserved: Record<string, number> = {};
    const maxEnergyObserved: Record<string, number> = {};
    const starvedTicksCount: Record<string, number> = {};
    const startingEnergy: Record<string, number> = {};

    for (const c of engine.getAllCompanies()) {
      energySums[c.companyId] = 0;
      minEnergyObserved[c.companyId] = c.energy;
      maxEnergyObserved[c.companyId] = c.energy;
      starvedTicksCount[c.companyId] = 0;
      startingEnergy[c.companyId] = c.energy;
    }

    // Step simulation across all ticks
    for (let tick = 0; tick < ticks; tick += 1) {
      controller.stepAndTick(engine);

      // Record tick metrics
      for (const c of engine.getAllCompanies()) {
        energySums[c.companyId] += c.energy;
        minEnergyObserved[c.companyId] = Math.min(minEnergyObserved[c.companyId], c.energy);
        maxEnergyObserved[c.companyId] = Math.max(maxEnergyObserved[c.companyId], c.energy);

        const hasStarvedLine = c.lines.some((l) => l.status === 'NO_ENERGY');
        if (hasStarvedLine || c.energy <= 0) {
          starvedTicksCount[c.companyId] += 1;
        }
      }
    }

    // Aggregate contract / market metrics
    const contracts = engine.getAllContracts();
    const totalOffersPosted = contracts.length;
    const acceptedContracts = contracts.filter((c) => c.status === 'ACTIVE' || c.status === 'FULFILLED');
    const fulfilledContracts = contracts.filter((c) => c.status === 'FULFILLED');

    let totalCreditsTransferred = 0;
    let totalMarketFeesBurned = 0;
    for (const c of fulfilledContracts) {
      totalCreditsTransferred += c.totalValueCredits;
      totalMarketFeesBurned += Math.floor((c.totalValueCredits * 2) / 100);
    }

    const companyMetrics: Record<string, EnergyBalanceMetrics> = {};
    const finalNetWorth: Record<string, number> = {};

    for (const c of engine.getAllCompanies()) {
      const avgEnergy = Math.round(energySums[c.companyId] / ticks);
      const totalBatches = c.lines.reduce((acc, l) => acc + l.totalBatchesProduced, 0);
      const companyFulfilled = fulfilledContracts.filter((con) => con.sellerCompanyId === c.companyId).length;

      companyMetrics[c.companyId] = {
        companyId: c.companyId,
        industrialClass: c.industrialClass,
        startingEnergy: startingEnergy[c.companyId],
        endingEnergy: c.energy,
        minEnergyObserved: minEnergyObserved[c.companyId],
        maxEnergyObserved: maxEnergyObserved[c.companyId],
        averageEnergy: avgEnergy,
        totalTicksSimulated: ticks,
        starvedTicksCount: starvedTicksCount[c.companyId],
        installedTurbinesR7: c.installedTurbinesR7,
        totalBatchesProduced: totalBatches,
        totalContractsFulfilled: companyFulfilled,
      };

      // Calculate NetWorth per GAME_DESIGN_MVP §6:
      // Credits + (R8 parts * 6000) + (R7 turbines * 2000) + (Reputation * 50)
      finalNetWorth[c.companyId] =
        c.credits +
        c.contributedMegamachinePartsR8 * 6000 +
        c.installedTurbinesR7 * 2000 +
        c.reputation * 50;
    }

    return {
      totalTicks: ticks,
      seed,
      companyMetrics,
      tradeMetrics: {
        totalOffersPosted,
        totalContractsAccepted: acceptedContracts.length,
        totalContractsFulfilled: fulfilledContracts.length,
        totalCreditsTransferred,
        totalMarketFeesBurned,
      },
      globalMegamachineParts: engine.getGlobalProject().deliveredMegamachineParts,
      finalNetWorth,
    };
  }

  /**
   * Quantifies the efficiency advantage of specialization and B2B trade vs autarchy.
   */
  public evaluateSpecializationIncentives(): {
    classAAutarchyPenalties: Record<RecipeId, { timeOverheadPercent: number; energyOverheadPercent: number }>;
    classBAutarchyPenalties: Record<RecipeId, { timeOverheadPercent: number; energyOverheadPercent: number }>;
  } {
    const classAAutarchyPenalties: Record<string, { timeOverheadPercent: number; energyOverheadPercent: number }> = {};
    const classBAutarchyPenalties: Record<string, { timeOverheadPercent: number; energyOverheadPercent: number }> = {};

    // For Class B recipes (R4, R5, R6), Class A pays heavy penalties
    for (const rId of ['R4', 'R5', 'R6'] as RecipeId[]) {
      const def = getRecipe(rId);
      const timeOverhead = Math.round(((def.classA.durationTicks - def.classB.durationTicks) / def.classB.durationTicks) * 100);
      const energyOverhead = Math.round(((def.classA.energyCost - def.classB.energyCost) / def.classB.energyCost) * 100);
      classAAutarchyPenalties[rId] = { timeOverheadPercent: timeOverhead, energyOverheadPercent: energyOverhead };
    }

    // For Class A recipes (R1, R2, R3), Class B pays heavy penalties
    for (const rId of ['R1', 'R2', 'R3'] as RecipeId[]) {
      const def = getRecipe(rId);
      const timeOverhead = Math.round(((def.classB.durationTicks - def.classA.durationTicks) / def.classA.durationTicks) * 100);
      const energyOverhead = Math.round(((def.classB.energyCost - def.classA.energyCost) / def.classA.energyCost) * 100);
      classBAutarchyPenalties[rId] = { timeOverheadPercent: timeOverhead, energyOverheadPercent: energyOverhead };
    }

    return {
      classAAutarchyPenalties: classAAutarchyPenalties as any,
      classBAutarchyPenalties: classBAutarchyPenalties as any,
    };
  }
}
