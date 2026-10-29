import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';
import { NpcController } from '../../../src/engine/npc/NpcController.ts';

describe('NPC Determinism and Rules Compliance', () => {
  it('reproduces identical simulation state byte-for-byte across two independent runs with the same seed', () => {
    const seed = 987654;
    const ticksToRun = 300;

    // Run 1
    const engine1 = new SimulatorEngine(seed);
    engine1.initializeStandardMatch();
    const controller1 = new NpcController({ seed });

    for (let t = 0; t < ticksToRun; t += 1) {
      controller1.stepAndTick(engine1);
    }
    const state1 = engine1.createCheckpoint();

    // Run 2
    const engine2 = new SimulatorEngine(seed);
    engine2.initializeStandardMatch();
    const controller2 = new NpcController({ seed });

    for (let t = 0; t < ticksToRun; t += 1) {
      controller2.stepAndTick(engine2);
    }
    const state2 = engine2.createCheckpoint();

    assert.equal(JSON.stringify(state1), JSON.stringify(state2));
  });

  it('guarantees NPC never produces items or credits outside engine rules', () => {
    const seed = 554433;
    const engine = new SimulatorEngine(seed);
    engine.initializeStandardMatch();
    const controller = new NpcController({ seed });

    for (let t = 0; t < 500; t += 1) {
      controller.stepAndTick(engine);

      // Verify invariant at every tick for NPC companies
      for (const npcId of ['comp_metal_02', 'comp_manuf_02']) {
        const company = engine.getCompany(npcId)!;
        // Invariant 1: Credits never negative
        assert.ok(company.credits >= 0);
        // Invariant 2: Energy never negative and within bounds
        assert.ok(company.energy >= 0);
        assert.ok(company.energy <= company.maxEnergyStorage);
        // Invariant 3: Inventories never negative
        for (const [, slot] of Object.entries(company.inventory)) {
          assert.ok(slot.available >= 0);
        }
      }
    }
  });

  it('produces at least two distinct sources of supply for key materials in a 2 human + 2 NPC match', () => {
    const seed = 778899;
    const engine = new SimulatorEngine(seed);
    engine.initializeStandardMatch();
    const controller = new NpcController({ seed });

    // Simulate human company 1 (AeroMetals, Class A) scheduling R1 and offering surplus IRON_INGOT
    engine.submitCommand({
      type: 'SET_PRODUCTION_TARGET',
      commandId: 'cmd_human_prod_1',
      companyId: 'comp_metal_01',
      scheduledTick: 0,
      idempotencyKey: 'human_r1_1',
      lineId: 'comp_metal_01_line_1',
      recipeId: 'R1',
      targetBatches: 2,
    });

    // Human posts offer for IRON_INGOT at tick 25
    engine.submitCommand({
      type: 'CREATE_SUPPLY_OFFER',
      commandId: 'cmd_human_offer_1',
      companyId: 'comp_metal_01',
      scheduledTick: 25,
      idempotencyKey: 'human_offer_iron_1',
      itemId: 'IRON_INGOT',
      quantity: 5,
      unitPriceCredits: 11,
      deadlineTicks: 500,
    });

    // Run 100 ticks allowing both human and NPC to produce and post offers
    for (let t = 0; t < 100; t += 1) {
      controller.stepAndTick(engine);
    }

    const contracts = engine.getAllContracts();
    const ironOffers = contracts.filter((c) => c.itemId === 'IRON_INGOT');

    // Sources of supply
    const sellers = new Set(ironOffers.map((c) => c.sellerCompanyId));

    // Acceptance criterion 1: at least two sources of supply for key materials!
    assert.ok(sellers.has('comp_metal_01'));
    assert.ok(sellers.has('comp_metal_02'));
    assert.ok(sellers.size >= 2);
  });
});
