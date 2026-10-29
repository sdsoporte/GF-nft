import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Mulberry32PRNG, SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';
import { DeterministicNpcPolicy } from '../../../src/engine/npc/DeterministicNpcPolicy.ts';
import {
  BASE_ENERGY_GENERATION_PER_TICK,
  computeTargetBufferFromInitialStock,
  DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT,
  DEFAULT_NPC_SELL_MARGIN_PERCENT,
  DEFAULT_STARTING_STOCK,
  NpcCompanyConfig,
  NPC_INITIAL_STOCK_RETENTION_RATIO,
} from '../../../src/engine/npc/types.ts';

describe('DeterministicNpcPolicy and Approved Product Decisions', () => {
  const approvedConfigA: NpcCompanyConfig = {
    companyId: 'comp_metal_02',
    targetBuffer: computeTargetBufferFromInitialStock(DEFAULT_STARTING_STOCK, NPC_INITIAL_STOCK_RETENTION_RATIO),
    preferredRecipes: ['R1', 'R2'],
    priceMarginPercent: DEFAULT_NPC_SELL_MARGIN_PERCENT,
    maxBuyPriceMarginPercent: DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT,
    offerBatchSizes: {
      IRON_INGOT: 5,
      STEEL_PLATE: 4,
    },
    offerDurationTicks: 300,
    minCreditReserve: 500,
    autoInstallTurbine: true,
    maxActiveOffers: 3,
  };

  it('Decision 1: calculates NPC sell price using fixed 20% margin over base unit cost', () => {
    const policy = new DeterministicNpcPolicy(approvedConfigA);

    // R1 (IRON_INGOT): base cost 50, output 5 => unit cost 10. +20% => 12
    assert.equal(policy.calculateSellPrice('IRON_INGOT'), 12);

    // R2 (STEEL_PLATE): base cost 120, output 4 => unit cost 30. +20% => 36
    assert.equal(policy.calculateSellPrice('STEEL_PLATE'), 36);

    // R3 (HEAVY_ALLOY): base cost 320, output 2 => unit cost 160. +20% => 192
    assert.equal(policy.calculateSellPrice('HEAVY_ALLOY'), 192);

    // R4 (MECH_FRAME): base cost 220, output 2 => unit cost 110. +20% => 132
    assert.equal(policy.calculateSellPrice('MECH_FRAME'), 132);

    assert.equal(DEFAULT_NPC_SELL_MARGIN_PERCENT, 20);
  });

  it('Decision 2: retains exactly 50% of initial stock per item before releasing surplus', () => {
    // 200 RAW_ORE starting stock => retains 100 RAW_ORE
    const buffer = computeTargetBufferFromInitialStock(DEFAULT_STARTING_STOCK, 0.5);
    assert.equal(buffer.RAW_ORE, 100);
    assert.equal(buffer.IRON_INGOT, 0);
    assert.equal(buffer.STEEL_PLATE, 0);

    const engine = new SimulatorEngine(42);
    engine.initializeStandardMatch();
    const company = engine.getCompany('comp_metal_02')!;
    const rng = new Mulberry32PRNG(12345);
    const policy = new DeterministicNpcPolicy(approvedConfigA);

    // If company has only 100 RAW_ORE (exact retention buffer), no surplus is scheduled for export
    company.inventory.RAW_ORE.available = 100;
    company.inventory.IRON_INGOT.available = 5; // buffer is 0, so all 5 are surplus!

    const decisions = policy.evaluateDecisions(company, engine.getAllContracts(), engine.getCurrentTick(), rng);

    // Surplus IRON_INGOT is immediately posted as an offer because buffer is 0
    const offerDecisions = decisions.filter((d) => d.type === 'CREATE_SUPPLY_OFFER');
    assert.ok(offerDecisions.length > 0);
    assert.equal(offerDecisions[0].type, 'CREATE_SUPPLY_OFFER');
    if (offerDecisions[0].type === 'CREATE_SUPPLY_OFFER') {
      assert.equal(offerDecisions[0].itemId, 'IRON_INGOT');
      assert.equal(offerDecisions[0].quantity, 5);
      assert.equal(offerDecisions[0].unitPriceCredits, 12);
    }
  });

  it('Decision 3: NPC buyers pay at most 1.0x base cost and reject higher priced offers', () => {
    const policy = new DeterministicNpcPolicy({
      ...approvedConfigA,
      companyId: 'comp_manuf_02',
      preferredRecipes: ['R4'], // R4 requires STEEL_PLATE and IRON_INGOT
      targetBuffer: { STEEL_PLATE: 10 },
      maxBuyPriceMarginPercent: DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT, // 0%
    });

    // R2 (STEEL_PLATE) base unit cost is 30 credits
    assert.equal(policy.calculateMaxBuyPrice('STEEL_PLATE'), 30);
    assert.equal(DEFAULT_NPC_MAX_BUY_PRICE_MARGIN_PERCENT, 0);

    const engine = new SimulatorEngine(42);
    engine.initializeStandardMatch();
    const company = engine.getCompany('comp_manuf_02')!;
    company.inventory.STEEL_PLATE.available = 0; // Needs steel plate

    const rng = new Mulberry32PRNG(12345);

    // Offer 1: priced at 31 credits (> 1.0x base cost) -> must be rejected
    const contractsReject = [
      {
        contractId: 'cnt_expensive',
        sellerCompanyId: 'comp_metal_01',
        buyerCompanyId: '',
        itemId: 'STEEL_PLATE' as const,
        totalQuantity: 4,
        deliveredQuantity: 0,
        unitPriceCredits: 31,
        totalValueCredits: 124,
        collateralSellerCredits: 24,
        createdAtTick: 0,
        deadlineTick: 300,
        penaltyPerMissingUnit: 10,
        status: 'PENDING' as const,
      },
    ];

    const decisionsReject = policy.evaluateDecisions(company, contractsReject, 1, rng);
    const acceptDecisionsReject = decisionsReject.filter((d) => d.type === 'ACCEPT_SUPPLY_OFFER');
    assert.equal(acceptDecisionsReject.length, 0);

    // Offer 2: priced at 30 credits (<= 1.0x base cost) -> must be accepted
    const contractsAccept = [
      {
        contractId: 'cnt_fair',
        sellerCompanyId: 'comp_metal_01',
        buyerCompanyId: '',
        itemId: 'STEEL_PLATE' as const,
        totalQuantity: 4,
        deliveredQuantity: 0,
        unitPriceCredits: 30,
        totalValueCredits: 120,
        collateralSellerCredits: 24,
        createdAtTick: 0,
        deadlineTick: 300,
        penaltyPerMissingUnit: 10,
        status: 'PENDING' as const,
      },
    ];

    const decisionsAccept = policy.evaluateDecisions(company, contractsAccept, 1, rng);
    const acceptDecisionsAccept = decisionsAccept.filter((d) => d.type === 'ACCEPT_SUPPLY_OFFER');
    assert.equal(acceptDecisionsAccept.length, 1);
    if (acceptDecisionsAccept[0].type === 'ACCEPT_SUPPLY_OFFER') {
      assert.equal(acceptDecisionsAccept[0].contractId, 'cnt_fair');
    }
  });

  it('Decision 4: base energy generation remains +20/tick in engine companies', () => {
    const engine = new SimulatorEngine(42);
    engine.initializeStandardMatch();

    assert.equal(BASE_ENERGY_GENERATION_PER_TICK, 20);
    for (const company of engine.getAllCompanies()) {
      assert.equal(company.energyGenerationPerTick, 20);
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
    const policy = new DeterministicNpcPolicy(approvedConfigA);

    const decisions = policy.evaluateDecisions(company, engine.getAllContracts(), engine.getCurrentTick(), rng);

    const transportDecisions = decisions.filter((d) => d.type === 'SCHEDULE_INTERNAL_TRANSPORT');
    assert.equal(transportDecisions.length, 1);
    if (transportDecisions[0].type === 'SCHEDULE_INTERNAL_TRANSPORT') {
      assert.equal(transportDecisions[0].contractId, createdContract.contractId);
      assert.equal(transportDecisions[0].quantityToShip, 5);
    }
  });
});
