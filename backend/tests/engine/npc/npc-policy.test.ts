import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Mulberry32PRNG, SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';
import { DeterministicNpcPolicy } from '../../../src/engine/npc/DeterministicNpcPolicy.ts';
import { NpcCompanyConfig } from '../../../src/engine/npc/types.ts';

describe('DeterministicNpcPolicy', () => {
  const defaultConfigA: NpcCompanyConfig = {
    companyId: 'comp_metal_02',
    targetBuffer: {
      RAW_ORE: 20,
      IRON_INGOT: 10,
      STEEL_PLATE: 5,
    },
    preferredRecipes: ['R1', 'R2'],
    priceMarginPercent: 15,
    maxBuyPriceMarginPercent: 25,
    offerBatchSizes: {
      IRON_INGOT: 5,
      STEEL_PLATE: 4,
    },
    offerDurationTicks: 300,
    minCreditReserve: 500,
    autoInstallTurbine: true,
    maxActiveOffers: 3,
  };

  it('generates production target for idle line when inputs are available', () => {
    const engine = new SimulatorEngine(42);
    engine.initializeStandardMatch();
    const company = engine.getCompany('comp_metal_02')!;
    const rng = new Mulberry32PRNG(12345);
    const policy = new DeterministicNpcPolicy(defaultConfigA);

    const decisions = policy.evaluateDecisions(company, engine.getAllContracts(), engine.getCurrentTick(), rng);

    // Initial state: 200 RAW_ORE available. comp_metal_02 has 3 IDLE lines.
    const productionDecisions = decisions.filter(d => d.type === 'SET_PRODUCTION_TARGET');
    assert.ok(productionDecisions.length > 0);
    assert.equal(productionDecisions[0].type, 'SET_PRODUCTION_TARGET');
    if (productionDecisions[0].type === 'SET_PRODUCTION_TARGET') {
      assert.equal(productionDecisions[0].recipeId, 'R1');
      assert.equal(productionDecisions[0].lineId, 'comp_metal_02_line_1');
    }
  });

  it('posts supply offer when surplus inventory exceeds target buffer', () => {
    const engine = new SimulatorEngine(42);
    engine.initializeStandardMatch();
    const company = engine.getCompany('comp_metal_02')!;
    company.inventory.IRON_INGOT.available = 25;

    const rng = new Mulberry32PRNG(12345);
    const policy = new DeterministicNpcPolicy(defaultConfigA);

    const decisions = policy.evaluateDecisions(company, engine.getAllContracts(), engine.getCurrentTick(), rng);

    const offerDecisions = decisions.filter(d => d.type === 'CREATE_SUPPLY_OFFER');
    assert.ok(offerDecisions.length > 0);
    if (offerDecisions[0].type === 'CREATE_SUPPLY_OFFER') {
      assert.equal(offerDecisions[0].itemId, 'IRON_INGOT');
      assert.equal(offerDecisions[0].quantity, 5);
      // R1 base cost is 50 for 5 units = 10 credits/unit. +15% margin = 12 credits/unit.
      assert.equal(offerDecisions[0].unitPriceCredits, 12);
      assert.equal(offerDecisions[0].deadlineTicks, 300);
    }
  });

  it('dispatches goods for active contracts where company is the seller', () => {
    const engine = new SimulatorEngine(42);
    engine.initializeStandardMatch();
    const company = engine.getCompany('comp_metal_02')!;
    company.inventory.IRON_INGOT.available = 20;

    engine.submitCommand({
      type: 'CREATE_SUPPLY_OFFER',
      commandId: 'cmd_offer_1',
      companyId: 'comp_metal_02',
      scheduledTick: 0,
      idempotencyKey: 'idem_1',
      itemId: 'IRON_INGOT',
      quantity: 5,
      unitPriceCredits: 12,
      deadlineTicks: 500,
    });
    engine.processTick();

    const createdContract = engine.getAllContracts()[0];
    assert.ok(createdContract !== undefined);

    engine.submitCommand({
      type: 'ACCEPT_SUPPLY_OFFER',
      commandId: 'cmd_accept_1',
      companyId: 'comp_manuf_01',
      scheduledTick: 1,
      idempotencyKey: 'idem_2',
      contractId: createdContract.contractId,
    });
    engine.processTick();

    const contract = engine.getContract(createdContract.contractId);
    assert.equal(contract?.status, 'ACTIVE');

    const rng = new Mulberry32PRNG(12345);
    const policy = new DeterministicNpcPolicy(defaultConfigA);

    const decisions = policy.evaluateDecisions(company, engine.getAllContracts(), engine.getCurrentTick(), rng);

    const transportDecisions = decisions.filter(d => d.type === 'SCHEDULE_INTERNAL_TRANSPORT');
    assert.equal(transportDecisions.length, 1);
    if (transportDecisions[0].type === 'SCHEDULE_INTERNAL_TRANSPORT') {
      assert.equal(transportDecisions[0].contractId, createdContract.contractId);
      assert.equal(transportDecisions[0].quantityToShip, 5);
    }
  });
});
