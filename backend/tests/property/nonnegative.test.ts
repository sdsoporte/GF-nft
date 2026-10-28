/**
 * Spec S3 — non-negativity and monotonicity invariants over the fixed seed corpus.
 *
 * After every processed tick the settled snapshot must satisfy:
 *
 * - every inventory `available`/`reserved`, credit balance, energy level,
 *   reputation, collateral, counter and batch field is a non-negative safe
 *   integer, and energy never exceeds the company's storage capacity;
 * - aggregate consistency: the parts a company contributed to the global project
 *   add up to the project counter (sunk material is never double counted);
 * - counters the engine actually guarantees never decrease: `tick` grows by
 *   exactly one, `totalBatchesProduced`, `maintenancePaidTicks`,
 *   `installedTurbinesR7`, `contributedMegamachinePartsR8`, `maxEnergyStorage`,
 *   `energyGenerationPerTick`, `lastActionTick`, `deliveredQuantity` and the
 *   global `deliveredMegamachineParts`.
 *
 * Counters that are NOT monotonic in this engine (credits, energy, reputation,
 * inventory levels) are covered by the non-negativity checks and by the
 * conservation ledger instead.
 *
 * Determinism: only the literal seed drives the engine (assumption A3).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { SimulationSnapshot } from '../../src/domain/types.ts';
import {
  METAL_A,
  buildScenarioCorpus,
  collectMonotonicViolations,
  collectNonNegativeViolations,
  runScenario,
} from './property-helpers.ts';

function contributedParts(snapshot: SimulationSnapshot): number {
  return Object.values(snapshot.companies).reduce(
    (sum, company) => sum + company.contributedMegamachinePartsR8,
    0,
  );
}

for (const scenario of buildScenarioCorpus()) {
  test(`balances stay non-negative and integral (seed ${scenario.seed}: ${scenario.label})`, () => {
    let observedTicks = 0;

    runScenario(scenario, {
      onTickEnd(_engine, tick, _before, after) {
        observedTicks += 1;
        const violations = collectNonNegativeViolations(after);
        assert.deepEqual(
          violations,
          [],
          `seed ${scenario.seed}: non-negativity violations at tick ${tick}`,
        );
        assert.equal(
          contributedParts(after),
          after.globalProject.deliveredMegamachineParts,
          `seed ${scenario.seed}: company contributions at tick ${tick} must match the project counter`,
        );
      },
    });

    assert.equal(observedTicks, scenario.totalTicks);
  });

  test(`guaranteed counters never regress (seed ${scenario.seed}: ${scenario.label})`, () => {
    runScenario(scenario, {
      onTickEnd(_engine, tick, before, after) {
        const violations = collectMonotonicViolations(before, after);
        assert.deepEqual(violations, [], `seed ${scenario.seed}: regressions at tick ${tick}`);
      },
    });
  });
}

test('a turbine expansion sinks one turbine and unlocks a fourth line', () => {
  const scenario = buildScenarioCorpus().find((candidate) => candidate.seed === 4096);
  assert.ok(scenario, 'turbine scenario must be part of the corpus');

  const engine = runScenario(scenario);
  const company = engine.getCompany(METAL_A);
  assert.ok(company, 'turbine company must exist');
  assert.equal(company.installedTurbinesR7, 1, 'the installed turbine is sunk into the grid');
  assert.equal(company.inventory.IND_TURBINE.available, 0, 'the turbine leaves the inventory');
  assert.equal(company.lines.length, 4, 'the expansion adds exactly one line');
  assert.equal(company.maxEnergyStorage, 1250, 'the expansion grows the battery by 250');
  assert.equal(company.energyGenerationPerTick, 35, 'the expansion adds 15 generation per tick');
});
