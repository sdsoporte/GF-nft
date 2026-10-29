import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NpcController } from '../../../src/engine/npc/NpcController.ts';
import { ReplayCommandInput, ReplayRunner } from '../../../src/engine/replay/ReplayRunner.ts';
import { SimulatorEngine } from '../../../src/engine/SimulatorEngine.ts';

describe('2,700-Tick Full Match Replay Suite (issue #11)', () => {
  it('replays a complete 2,700-tick match from seed and command log with byte-identical checkpoints and final checksum', () => {
    const seed = 42107;
    const totalTicks = 2700;
    const checkpointInterval = 300;

    // 1. Run live match generating commands via NPC controller and human actions
    const liveEngine = new SimulatorEngine(seed);
    liveEngine.initializeStandardMatch();

    const npcController = new NpcController({ seed });
    const recordedCommands: ReplayCommandInput[] = [];

    // Schedule sample human commands at tick 1 and tick 25
    const liveCheckpoints: Array<{ tick: number; hash: string; checksum: string }> = [];

    // Advance 2,700 ticks
    for (let tick = 0; tick < totalTicks; tick += 1) {
      const currentTick = liveEngine.getCurrentTick();

      // Submit human commands at specific ticks
      if (currentTick === 1) {
        const humanCmd = {
          type: 'SET_PRODUCTION_TARGET' as const,
          commandId: 'cmd_human_r1_tick1',
          companyId: 'comp_metal_01',
          scheduledTick: 1,
          idempotencyKey: 'idem_human_r1_1',
          lineId: 'comp_metal_01_line_1',
          recipeId: 'R1' as const,
          targetBatches: 2,
        };
        liveEngine.submitCommand(humanCmd);
        recordedCommands.push({ submitAtTick: currentTick, command: humanCmd });
      }

      if (currentTick === 25) {
        const humanOffer = {
          type: 'CREATE_SUPPLY_OFFER' as const,
          commandId: 'cmd_human_offer_tick25',
          companyId: 'comp_metal_01',
          scheduledTick: 25,
          idempotencyKey: 'idem_human_offer_1',
          itemId: 'IRON_INGOT' as const,
          quantity: 5,
          unitPriceCredits: 12,
          deadlineTicks: 400,
        };
        liveEngine.submitCommand(humanOffer);
        recordedCommands.push({ submitAtTick: currentTick, command: humanOffer });
      }

      // Step NPC controller and record any submitted commands
      const npcCmds = npcController.stepTick(liveEngine);
      for (const cmd of npcCmds) {
        recordedCommands.push({ submitAtTick: currentTick, command: cmd });
      }

      liveEngine.processTick();
      const afterTick = liveEngine.getCurrentTick();

      if (afterTick % checkpointInterval === 0 || afterTick === totalTicks) {
        liveCheckpoints.push({
          tick: afterTick,
          hash: liveEngine.calculateStateHash(),
          checksum: liveEngine.calculateStateChecksumSha256(),
        });
      }
    }

    const liveFinalHash = liveEngine.calculateStateHash();
    const liveFinalChecksum = liveEngine.calculateStateChecksumSha256();

    // 2. Replay the match from seed + recorded commands using ReplayRunner
    const runner = new ReplayRunner();
    const replayResult = runner.run(seed, recordedCommands, {
      targetTicks: totalTicks,
      checkpointInterval,
    });

    // 3. Verify exact final state hash and robust SHA-256 checksum
    assert.equal(replayResult.finalStateHash, liveFinalHash);
    assert.equal(replayResult.finalChecksumSha256, liveFinalChecksum);

    // 4. Verify all checkpoints match
    assert.equal(replayResult.checkpoints.length - 1, liveCheckpoints.length);
    for (const liveCp of liveCheckpoints) {
      const replayedCp = replayResult.checkpoints.find((c) => c.tick === liveCp.tick);
      assert.ok(replayedCp !== undefined, `Missing checkpoint for tick ${liveCp.tick}`);
      assert.equal(replayedCp.stateHash, liveCp.hash);
      assert.equal(replayedCp.checksumSha256, liveCp.checksum);
    }

    // 5. Verify verification outcome has 0 differences
    const verification = runner.verify(
      {
        seed,
        ruleVersion: '4.1',
        totalTicks,
        finalStateHash: liveFinalHash,
        finalChecksumSha256: liveFinalChecksum,
        checkpoints: replayResult.checkpoints,
        finalCanonicalState: replayResult.finalCanonicalState,
      },
      replayResult
    );
    assert.equal(verification.isMatch, true);
    assert.equal(verification.differences.length, 0);
  });
});
