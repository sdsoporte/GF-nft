/**
 * Spec S3 — conservation invariants over the fixed seed corpus.
 *
 * Two ledgers are asserted after every processed tick:
 *
 * 1. MATERIAL (`material is conserved ...`). Declared sources and sinks are the
 *    ones enumerated in `property-helpers.ts`: raw ore extraction is the only
 *    material source, and the only paths that take material out of circulation
 *    are turbines sunk into the grid, parts contributed to the global project and
 *    work-in-progress held by an active batch (all counted explicitly). Recipe
 *    input consumption is mass-neutral because the completed batch re-emits it,
 *    and internal transport is a transfer between two companies. Every scenario
 *    is therefore asserted against the exact equality
 *    `mass(t) === mass(0) + extractedMass(t)`, where extraction is predicted from
 *    the *observed* energy of the tick that starts each 10-tick cycle.
 *
 * 2. CREDITS (`credits only move ...`). Scoped to the flows that hold today:
 *    production and transport move no credits, so in contract-free scenarios the
 *    only credit sink is the 300-tick maintenance fee
 *    (`MAINTENANCE_COST_PER_LINE` per billable line). Contract settlement is
 *    asserted in `credits.test.ts`; the open partial-delivery defect (issue #5)
 *    is deliberately not asserted as value-conserving here.
 *
 * Determinism: only the literal seed drives the engine (assumption A3); this file
 * contains no `Math.random` and no wall-clock reads.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { RECIPE_CATALOG } from '../../src/domain/recipeCatalog.ts';
import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import type { RecipeId, SimulationSnapshot } from '../../src/domain/types.ts';
import {
  EXTRACTION_MASS_PER_COMPANY,
  MATERIAL_WEIGHTS,
  batchInputMass,
  buildScenarioCorpus,
  computeMaterialMass,
  corpusSeeds,
  countBillableLines,
  countExtractingCompanies,
  runScenario,
  totalCredits,
} from './property-helpers.ts';

const RECIPE_IDS = Object.keys(RECIPE_CATALOG) as RecipeId[];

function creditsByCompany(snapshot: SimulationSnapshot): Record<string, number> {
  const credits: Record<string, number> = {};
  for (const [companyId, company] of Object.entries(snapshot.companies)) {
    credits[companyId] = company.credits;
  }
  return credits;
}

test('the corpus uses literal seeds only and stays within 8-20 scenarios', () => {
  const seeds = corpusSeeds();
  assert.ok(seeds.length >= 8 && seeds.length <= 20, `unexpected corpus size ${seeds.length}`);
  assert.equal(new Set(seeds).size, seeds.length, 'corpus seeds must be distinct');
  for (const seed of seeds) {
    assert.ok(Number.isSafeInteger(seed) && seed >= 0, `seed ${seed} must be a literal safe integer`);
  }
});

test('material weights are integral and every recipe is mass-closed', () => {
  assert.equal(MATERIAL_WEIGHTS.RAW_ORE, 4, 'raw ore is the accounting base unit');
  for (const recipeId of RECIPE_IDS) {
    const recipe = RECIPE_CATALOG[recipeId];
    const inputMass = batchInputMass(recipeId);
    const outputMass = MATERIAL_WEIGHTS[recipe.outputItem] * recipe.outputQuantity;
    assert.ok(
      Number.isSafeInteger(inputMass) && Number.isSafeInteger(outputMass),
      `${recipeId} weights must be safe integers (${inputMass}/${outputMass})`,
    );
    assert.equal(inputMass, outputMass, `${recipeId} must conserve material mass`);
    assert.ok(inputMass > 0, `${recipeId} must consume material`);
  }
});

for (const scenario of buildScenarioCorpus()) {
  test(`material is conserved across extraction, production and transfers (seed ${scenario.seed}: ${scenario.label})`, () => {
    let expectedMass = 0;
    let lastMass = 0;
    let observedTicks = 0;

    runScenario(scenario, {
      onStart(engine) {
        expectedMass = computeMaterialMass(engine);
        lastMass = expectedMass;
      },
      onTickEnd(engine, tick, before) {
        observedTicks += 1;
        const extractingCompanies = countExtractingCompanies(before, tick);
        expectedMass += extractingCompanies * EXTRACTION_MASS_PER_COMPANY;

        const actualMass = computeMaterialMass(engine);
        assert.equal(
          actualMass,
          expectedMass,
          `seed ${scenario.seed}: material mass diverged at tick ${tick} ` +
            `(${extractingCompanies} extracting companies declared as source)`,
        );
        // Extraction is the only source and nothing else is lost: mass may only
        // grow, and only by whole extraction cycles.
        assert.ok(actualMass >= lastMass, `seed ${scenario.seed}: mass decreased at tick ${tick}`);
        assert.equal(
          (actualMass - lastMass) % EXTRACTION_MASS_PER_COMPANY,
          0,
          `seed ${scenario.seed}: tick ${tick} changed mass by a non-cycle amount`,
        );
        lastMass = actualMass;
      },
    });

    assert.equal(observedTicks, scenario.totalTicks);
  });
}

for (const scenario of buildScenarioCorpus().filter((candidate) => !candidate.contractsEnabled)) {
  test(`credits only move through the declared maintenance sink (seed ${scenario.seed}: ${scenario.label})`, () => {
    let initialCredits = 0;
    let declaredSink = 0;
    let observedMaintenanceTicks = 0;

    runScenario(scenario, {
      onStart(engine) {
        initialCredits = totalCredits(engine.createSnapshot());
      },
      onTickEnd(engine, tick, before, after) {
        if (tick % SimulatorEngine.MAINTENANCE_INTERVAL_TICKS !== 0) {
          assert.deepEqual(
            creditsByCompany(after),
            creditsByCompany(before),
            `seed ${scenario.seed}: credits moved at non-maintenance tick ${tick}`,
          );
          return;
        }

        observedMaintenanceTicks += 1;
        for (const [companyId, previous] of Object.entries(before.companies)) {
          const next = after.companies[companyId];
          assert.ok(next, `seed ${scenario.seed}: company ${companyId} disappeared`);
          const decrease = previous.credits - next.credits;
          const paidInFull = next.maintenancePaidTicks > previous.maintenancePaidTicks;

          if (paidInFull) {
            // Paid branch: statuses are untouched, so the settled snapshot still
            // shows exactly the lines that were billed.
            assert.equal(
              next.maintenancePaidTicks,
              previous.maintenancePaidTicks + 1,
              `seed ${scenario.seed}: maintenancePaidTicks must advance once per interval`,
            );
            const due =
              countBillableLines(next) * SimulatorEngine.MAINTENANCE_COST_PER_LINE;
            assert.equal(
              decrease,
              due,
              `seed ${scenario.seed}: tick ${tick} charged ${decrease} to ${companyId}, expected ${due}`,
            );
          } else {
            // Unpaid branch: the engine drains the remaining credits and floors at zero.
            assert.equal(
              decrease,
              previous.credits,
              `seed ${scenario.seed}: unpaid maintenance must drain ${companyId}`,
            );
            assert.equal(next.credits, 0, `seed ${scenario.seed}: credits must floor at zero`);
            assert.ok(
              next.reputation <= previous.reputation,
              `seed ${scenario.seed}: unpaid maintenance must not raise reputation`,
            );
          }
          declaredSink += decrease;
        }

        assert.ok(
          totalCredits(after) <= totalCredits(before),
          `seed ${scenario.seed}: total credits increased without a declared source`,
        );
      },
    });

    assert.equal(
      observedMaintenanceTicks,
      Math.floor(scenario.totalTicks / SimulatorEngine.MAINTENANCE_INTERVAL_TICKS),
    );
    assert.equal(
      totalCredits(runScenarioAgain(scenario)),
      initialCredits - declaredSink,
      `seed ${scenario.seed}: final credits must equal the initial balance minus the declared sink`,
    );
  });
}

/**
 * Replay the same literal seed and script so the final balance can be compared
 * with the ledger accumulated during the instrumented run. Same inputs, same
 * state (assumption A3) — no wall clock is involved.
 */
function runScenarioAgain(scenario: ReturnType<typeof buildScenarioCorpus>[number]): SimulationSnapshot {
  return runScenario(scenario).createSnapshot();
}
