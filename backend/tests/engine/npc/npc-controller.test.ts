import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';
import { NpcController } from '../../../src/engine/npc/NpcController.ts';

describe('NpcController', () => {
  it('registers default NPC companies and submits commands to engine', () => {
    const engine = new SimulatorEngine(42107);
    engine.initializeStandardMatch();

    const controller = new NpcController({ seed: 42107 });
    assert.deepEqual(controller.getRegisteredCompanyIds(), ['comp_metal_02', 'comp_manuf_02']);

    // Tick 0 -> stepTick should evaluate NPC policies and submit initial production commands
    const commands = controller.stepTick(engine);
    assert.ok(commands.length > 0);

    // Initial commands should include SET_PRODUCTION_TARGET for comp_metal_02 (which has raw ore)
    const metalProd = commands.find(
      (c) => c.companyId === 'comp_metal_02' && c.type === 'SET_PRODUCTION_TARGET'
    );
    assert.ok(metalProd !== undefined);

    // Process tick and verify line started
    engine.processTick();
    const metalCompany = engine.getCompany('comp_metal_02')!;
    const line1 = metalCompany.lines[0];
    assert.equal(line1.status, 'RUNNING');
    assert.equal(line1.currentRecipeId, 'R1');
  });

  it('runs multiple ticks deterministically and generates market offers', () => {
    const engine = new SimulatorEngine(1001);
    engine.initializeStandardMatch();

    const controller = new NpcController({ seed: 1001 });

    let totalOffersCreated = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      const cmds = controller.stepAndTick(engine);
      const offers = cmds.filter((c) => c.type === 'CREATE_SUPPLY_OFFER');
      totalOffersCreated += offers.length;
    }

    const metalCompany = engine.getCompany('comp_metal_02')!;
    const contracts = engine.getAllContracts();

    // Verify comp_metal_02 produced batches and posted at least one offer for IRON_INGOT
    assert.ok(metalCompany.lines[0].totalBatchesProduced > 0);
    const metalOffers = contracts.filter((c) => c.sellerCompanyId === 'comp_metal_02');
    assert.ok(metalOffers.length > 0);
    assert.equal(metalOffers[0].itemId, 'IRON_INGOT');
  });
});
