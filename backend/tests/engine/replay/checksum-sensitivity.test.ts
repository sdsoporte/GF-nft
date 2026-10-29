import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';
import {
  computeStateChecksumSha256,
  extractCanonicalSimulationState,
} from '../../../src/engine/replay/canonicalState.ts';
import { diffCanonicalStates } from '../../../src/engine/replay/stateDiff.ts';

describe('Checksum Sensitivity and State Diff Reporting (issue #11)', () => {
  it('computes identical SHA-256 checksum for identical states', () => {
    const engine1 = new SimulatorEngine(100);
    engine1.initializeStandardMatch();

    const engine2 = new SimulatorEngine(100);
    engine2.initializeStandardMatch();

    const state1 = extractCanonicalSimulationState(engine1);
    const state2 = extractCanonicalSimulationState(engine2);

    const checksum1 = computeStateChecksumSha256(state1);
    const checksum2 = computeStateChecksumSha256(state2);

    assert.equal(checksum1, checksum2);
    assert.equal(checksum1.length, 64); // SHA-256 hex string

    const diffs = diffCanonicalStates(state1, state2);
    assert.equal(diffs.length, 0);
  });

  it('detects inventory modification and reports difference per entity and field', () => {
    const engine1 = new SimulatorEngine(100);
    engine1.initializeStandardMatch();

    const engine2 = new SimulatorEngine(100);
    engine2.initializeStandardMatch();

    // Mutate inventory in engine2: comp_metal_01 RAW_ORE from 200 to 205
    const company2 = engine2.getCompany('comp_metal_01')!;
    company2.inventory.RAW_ORE.available = 205;

    const state1 = extractCanonicalSimulationState(engine1);
    const state2 = extractCanonicalSimulationState(engine2);

    const checksum1 = computeStateChecksumSha256(state1);
    const checksum2 = computeStateChecksumSha256(state2);

    // Checksum MUST change
    assert.notEqual(checksum1, checksum2);

    // Diff must report the exact entity and field
    const diffs = diffCanonicalStates(state1, state2);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].entityType, 'inventory');
    assert.equal(diffs[0].entityId, 'comp_metal_01:RAW_ORE');
    assert.equal(diffs[0].field, 'available');
    assert.equal(diffs[0].expected, 200);
    assert.equal(diffs[0].actual, 205);
  });

  it('detects contract creation, status or delivery changes in checksum', () => {
    const engine1 = new SimulatorEngine(100);
    engine1.initializeStandardMatch();

    const engine2 = new SimulatorEngine(100);
    engine2.initializeStandardMatch();

    // Submit and accept a contract in engine2
    engine2.submitCommand({
      type: 'CREATE_SUPPLY_OFFER',
      commandId: 'cmd_offer_test',
      companyId: 'comp_metal_01',
      scheduledTick: 0,
      idempotencyKey: 'idem_offer_test',
      itemId: 'IRON_INGOT',
      quantity: 5,
      unitPriceCredits: 12,
      deadlineTicks: 500,
    });
    engine2.processTick();

    const state1 = extractCanonicalSimulationState(engine1);
    const state2 = extractCanonicalSimulationState(engine2);

    const checksum1 = computeStateChecksumSha256(state1);
    const checksum2 = computeStateChecksumSha256(state2);

    assert.notEqual(checksum1, checksum2);

    const diffs = diffCanonicalStates(state1, state2);
    // Diff should report contracts and the tick/command difference
    const contractDiff = diffs.find((d) => d.entityType === 'contract');
    assert.ok(contractDiff !== undefined);
  });

  it('detects production line status, priority, and active batch changes', () => {
    const engine1 = new SimulatorEngine(100);
    engine1.initializeStandardMatch();

    const engine2 = new SimulatorEngine(100);
    engine2.initializeStandardMatch();

    // Start production on line 1 in engine2
    engine2.submitCommand({
      type: 'SET_PRODUCTION_TARGET',
      commandId: 'cmd_prod_test',
      companyId: 'comp_metal_01',
      scheduledTick: 0,
      idempotencyKey: 'idem_prod_test',
      lineId: 'comp_metal_01_line_1',
      recipeId: 'R1',
      targetBatches: 1,
    });
    engine2.processTick();

    const state1 = extractCanonicalSimulationState(engine1);
    const state2 = extractCanonicalSimulationState(engine2);

    const checksum1 = computeStateChecksumSha256(state1);
    const checksum2 = computeStateChecksumSha256(state2);

    assert.notEqual(checksum1, checksum2);

    const diffs = diffCanonicalStates(state1, state2);
    const lineDiff = diffs.find((d) => d.entityType === 'line' || d.entityType === 'batch');
    assert.ok(lineDiff !== undefined);
  });

  it('detects company credit and energy changes', () => {
    const engine1 = new SimulatorEngine(100);
    engine1.initializeStandardMatch();

    const engine2 = new SimulatorEngine(100);
    engine2.initializeStandardMatch();

    const comp2 = engine2.getCompany('comp_metal_01')!;
    comp2.credits -= 100;

    const state1 = extractCanonicalSimulationState(engine1);
    const state2 = extractCanonicalSimulationState(engine2);

    const checksum1 = computeStateChecksumSha256(state1);
    const checksum2 = computeStateChecksumSha256(state2);

    assert.notEqual(checksum1, checksum2);

    const diffs = diffCanonicalStates(state1, state2);
    const creditDiff = diffs.find((d) => d.entityType === 'company' && d.field === 'credits');
    assert.ok(creditDiff !== undefined);
    assert.equal(creditDiff.expected, 10000);
    assert.equal(creditDiff.actual, 9900);
  });
});
