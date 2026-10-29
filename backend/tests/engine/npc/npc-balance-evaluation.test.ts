import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BalanceEvaluationRunner } from '../../../src/engine/npc/balanceEvaluation.ts';
import { NpcController } from '../../../src/engine/npc/NpcController.ts';
import { SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';

describe('NPC 2700-tick Balance and Energy Evaluation', () => {
  it('simulates a complete 2,700-tick match with observable economic decisions and energy metrics', () => {
    const runner = new BalanceEvaluationRunner();
    const seed = 42107;
    const result = runner.runSimulation(seed, 2700);

    assert.equal(result.totalTicks, 2700);
    assert.equal(result.seed, seed);

    // Verify NPC companies ran throughout the match
    const metalNpc = result.companyMetrics['comp_metal_02'];
    const manufNpc = result.companyMetrics['comp_manuf_02'];

    assert.ok(metalNpc !== undefined);
    assert.ok(manufNpc !== undefined);

    // Production took place over the 2700 ticks
    assert.ok(metalNpc.totalBatchesProduced > 0);
    assert.ok(metalNpc.averageEnergy > 0);
    assert.ok(metalNpc.minEnergyObserved >= 0);

    // Offers and trade took place
    assert.ok(result.tradeMetrics.totalOffersPosted > 0);

    // Final NetWorth was calculated for each company
    for (const [, netWorth] of Object.entries(result.finalNetWorth)) {
      assert.ok(netWorth > 0);
    }
  });

  it('measures the strategic return and capacity boost of installing R7 Industrial Turbines', () => {
    const engineWithTurbine = new SimulatorEngine(12345);
    engineWithTurbine.initializeStandardMatch();

    // Give comp_metal_02 an IND_TURBINE at tick 899 to test expansion
    const metalCompany = engineWithTurbine.getCompany('comp_metal_02')!;
    metalCompany.inventory.IND_TURBINE.available = 1;

    const controllerWithTurbine = new NpcController({
      seed: 12345,
    });

    // Advance past tick 900
    for (let t = 0; t < 950; t += 1) {
      controllerWithTurbine.stepAndTick(engineWithTurbine);
    }

    // comp_metal_02 should have installed the turbine expansion!
    const expandedCompany = engineWithTurbine.getCompany('comp_metal_02')!;
    assert.equal(expandedCompany.installedTurbinesR7, 1);
    // Grid expansion: generation +15 (20 -> 35), storage +250 (1000 -> 1250), lines +1 (3 -> 4)
    assert.equal(expandedCompany.energyGenerationPerTick, 35);
    assert.equal(expandedCompany.maxEnergyStorage, 1250);
    assert.equal(expandedCompany.lines.length, 4);
  });

  it('proves specialization penalties create natural economic incentive for trade without tutorial', () => {
    const runner = new BalanceEvaluationRunner();
    const incentives = runner.evaluateSpecializationIncentives();

    // For Class B recipes (R4, R5, R6), Class A pays +100% time and +100% to +128% energy
    assert.equal(incentives.classAAutarchyPenalties['R4'].timeOverheadPercent, 100);
    assert.equal(incentives.classAAutarchyPenalties['R4'].energyOverheadPercent, 100);
    assert.equal(incentives.classAAutarchyPenalties['R5'].timeOverheadPercent, 100);
    assert.equal(incentives.classAAutarchyPenalties['R5'].energyOverheadPercent, 129);
    assert.equal(incentives.classAAutarchyPenalties['R6'].timeOverheadPercent, 100);
    assert.equal(incentives.classAAutarchyPenalties['R6'].energyOverheadPercent, 120);

    // For Class A recipes (R1, R2, R3), Class B pays +100% to +120% time and +100% energy
    assert.equal(incentives.classBAutarchyPenalties['R1'].timeOverheadPercent, 100);
    assert.equal(incentives.classBAutarchyPenalties['R1'].energyOverheadPercent, 100);
    assert.equal(incentives.classBAutarchyPenalties['R2'].timeOverheadPercent, 100);
    assert.equal(incentives.classBAutarchyPenalties['R2'].energyOverheadPercent, 100);
    assert.equal(incentives.classBAutarchyPenalties['R3'].timeOverheadPercent, 120);
    assert.equal(incentives.classBAutarchyPenalties['R3'].energyOverheadPercent, 100);
  });
});
