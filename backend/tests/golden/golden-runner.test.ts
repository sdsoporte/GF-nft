/**
 * Golden replay runner — specs S5 and S9 of issue #10.
 *
 * For every scenario in `scenarios.ts` this file asserts:
 *
 * - **S9 (determinism/replay)**: two independent in-process runs of the same
 *   seed + command script serialize to byte-identical canonical state, both at
 *   every checkpoint tick and at the end of the run. Comparing checkpoints too
 *   catches state that diverges mid-run and re-converges by the last tick.
 * - **S5 (golden fixtures)**: the committed fixture under `tests/golden/fixtures`
 *   equals those canonical bytes exactly, so ANY divergence — one credit, one
 *   progress tick, one reputation point, one contract status — fails the run.
 *
 * A plain `bun test tests/golden` run is read-only: fixtures are only written by
 * the explicit regeneration opt-in, so CI can never rewrite its own baseline.
 *
 *     bun test tests/golden                                  # verify (read-only)
 *     GOLDEN_UPDATE=1 bun test tests/golden                  # regenerate fixtures
 *
 * Regenerating is a reviewable act: read the fixture diff before committing it.
 * Do not "fix" a failing golden by editing `src/`; a divergence is either an
 * intended behaviour change (regenerate + review) or a real regression (report).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  UPDATE_FIXTURES,
  canonicalJson,
  firstDivergence,
  goldenDocument,
  listGoldenFixtures,
  loadGoldenFixture,
  runScenario,
} from './golden-helpers.ts';
import { SCENARIOS } from './scenarios.ts';

describe('golden scenario definitions', () => {
  test('names are unique and every declared tick is reachable', () => {
    const names = new Set<string>();

    for (const scenario of SCENARIOS) {
      assert.equal(names.has(scenario.name), false, `duplicate scenario name ${scenario.name}`);
      names.add(scenario.name);

      assert.ok(Number.isSafeInteger(scenario.seed), `${scenario.name}: seed must be a safe integer`);
      assert.ok(scenario.totalTicks > 0, `${scenario.name}: needs at least one tick`);
      assert.ok(scenario.checkpoints.length > 0, `${scenario.name}: declare checkpoint ticks`);

      for (const checkpoint of scenario.checkpoints) {
        assert.ok(
          Number.isSafeInteger(checkpoint) && checkpoint >= 1 && checkpoint <= scenario.totalTicks,
          `${scenario.name}: checkpoint ${checkpoint} must be inside 1..${scenario.totalTicks}`,
        );
      }

      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index]!;
        assert.ok(
          step.tick >= 1 && step.tick <= scenario.totalTicks,
          `${scenario.name}: step "${step.label}" is scheduled outside the run`,
        );
        if (index > 0) {
          assert.ok(
            step.tick > scenario.steps[index - 1]!.tick,
            `${scenario.name}: steps must be declared in strictly increasing tick order`,
          );
        }
      }
    }

    assert.equal(SCENARIOS.length >= 2, true, 'at least two golden scenarios must exist (S5)');
  });

  test('every scenario keeps a distinct, reviewable command script', () => {
    const scripts = SCENARIOS.map((scenario) =>
      canonicalJson(
        scenario.steps.map((step) => ({ tick: step.tick, commands: step.commands ?? [] })),
      ),
    );

    for (const script of scripts) {
      assert.notEqual(script.trim(), '[]', 'a golden scenario must script at least one command');
    }
    assert.equal(new Set(scripts).size, scripts.length, 'two scenarios share the same command script');
  });
});

describe('canonical serialization', () => {
  test('object key order never changes the bytes', () => {
    const first = canonicalJson({ b: 1, a: { d: [3, 2, 1], c: 'x' } });
    const second = canonicalJson({ a: { c: 'x', d: [3, 2, 1] }, b: 1 });

    assert.equal(first, second);
    assert.equal(first.endsWith('\n'), true, 'canonical documents end with exactly one newline');
  });

  test('rejects non-integers and folds negative zero', () => {
    assert.throws(() => canonicalJson({ credits: 1.5 }), /must be a safe integer/);
    assert.throws(() => canonicalJson({ credits: Number.NaN }), /must be a safe integer/);
    assert.equal(canonicalJson({ credits: -0 }), canonicalJson({ credits: 0 }));
  });

  test('undefined optional fields are omitted rather than serialized as null', () => {
    assert.equal(canonicalJson({ status: 'PENDING', settledAtTick: undefined }), '{"status":"PENDING"}\n');
  });
});

for (const scenario of SCENARIOS) {
  describe(`golden scenario "${scenario.name}"`, () => {
    test('S9: two runs of the same seed and script are byte-identical', () => {
      const first = runScenario(scenario);
      const second = runScenario(scenario);

      assert.equal(
        first.submittedCommands,
        second.submittedCommands,
        'both runs must submit the same number of commands',
      );

      const firstDoc = goldenDocument(scenario, first);
      const secondDoc = goldenDocument(scenario, second);

      assert.equal(
        second.finalBytes,
        first.finalBytes,
        `two runs of ${scenario.name} diverged:\n${firstDivergence(first.finalBytes, second.finalBytes)}`,
      );
      assert.equal(
        secondDoc,
        firstDoc,
        `two runs of ${scenario.name} diverged in the committed document:\n`
          + firstDivergence(firstDoc, secondDoc),
      );

      for (const checkpoint of scenario.checkpoints) {
        const firstCheckpoint = first.checkpointBytes.get(checkpoint);
        const secondCheckpoint = second.checkpointBytes.get(checkpoint);
        assert.ok(firstCheckpoint, `${scenario.name}: checkpoint ${checkpoint} must be captured`);
        assert.ok(secondCheckpoint, `${scenario.name}: checkpoint ${checkpoint} must be captured twice`);
        assert.equal(
          secondCheckpoint,
          firstCheckpoint,
          `${scenario.name}: runs diverged at checkpoint tick ${checkpoint}:\n`
            + firstDivergence(firstCheckpoint, secondCheckpoint),
        );
      }

      // A run must not depend on serialization order either: re-serializing the
      // captured state has to reproduce the same bytes.
      assert.equal(canonicalJson(first.finalState), first.finalBytes);
    });

    test('S5: the committed golden fixture matches the replay exactly', () => {
      const run = runScenario(scenario);
      const actual = goldenDocument(scenario, run);
      const expected = loadGoldenFixture(scenario.name, actual);

      assert.equal(
        actual,
        expected,
        UPDATE_FIXTURES
          ? `${scenario.name}: the fixture written by GOLDEN_UPDATE=1 did not read back identically`
          : `${scenario.name}: golden fixture diverged — regenerate with GOLDEN_UPDATE=1 bun test tests/golden `
            + `only if the change is intended:\n${firstDivergence(expected, actual)}`,
      );
    });
  });
}

// Runs last: after regeneration in update mode, otherwise straight away.
describe('golden fixture inventory', () => {
  test('the fixtures directory holds exactly one fixture per declared scenario', () => {
    if (UPDATE_FIXTURES) {
      // Regeneration writes the files during this same run.
      return;
    }

    assert.deepEqual(
      listGoldenFixtures(),
      SCENARIOS.map((scenario) => scenario.name).sort(),
      'a stale fixture must be deleted and a new scenario must ship its fixture',
    );
  });
});
