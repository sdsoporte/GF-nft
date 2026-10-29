/**
 * GigaForge v4.1 - Replay Runner
 * Executes and verifies deterministic match replays from seed + scheduled commands.
 */

import { EnqueueCommandInput, IndustrialClass } from '../../domain/types.ts';
import { SimulatorEngine } from '../SimulatorEngine.ts';
import {
  CanonicalSimulationState,
  computeStateChecksumSha256,
  extractCanonicalSimulationState,
} from './canonicalState.ts';
import { diffCanonicalStates, StateDifference } from './stateDiff.ts';

export interface ReplayCommandEntry {
  readonly submitAtTick: number;
  readonly command: EnqueueCommandInput;
}

export type ReplayCommandInput = EnqueueCommandInput | ReplayCommandEntry;

export interface ReplayCheckpoint {
  readonly tick: number;
  readonly stateHash: string;
  readonly checksumSha256: string;
  readonly canonicalState: CanonicalSimulationState;
}

export interface ReplayExecutionResult {
  readonly seed: number;
  readonly ruleVersion: string;
  readonly totalTicks: number;
  readonly finalStateHash: string;
  readonly finalChecksumSha256: string;
  readonly checkpoints: readonly ReplayCheckpoint[];
  readonly finalCanonicalState: CanonicalSimulationState;
}

export interface ReplayOptions {
  readonly ruleVersion?: string;
  readonly checkpointInterval?: number; // default 300
  readonly targetTicks?: number;
  readonly customCompanies?: Array<{
    id: string;
    name: string;
    industrialClass: IndustrialClass;
    isNPC: boolean;
  }>;
}

export interface ReplayVerificationOutcome {
  readonly isMatch: boolean;
  readonly differences: readonly StateDifference[];
  readonly mismatchedCheckpoints: readonly {
    readonly tick: number;
    readonly expectedHash: string;
    readonly actualHash: string;
    readonly expectedChecksum: string;
    readonly actualChecksum: string;
  }[];
}

export function isReplayCommandEntry(
  item: ReplayCommandInput
): item is ReplayCommandEntry {
  return (
    typeof item === 'object' &&
    item !== null &&
    'submitAtTick' in item &&
    typeof (item as ReplayCommandEntry).submitAtTick === 'number'
  );
}

export class ReplayRunner {
  /**
   * Run simulation from seed and scheduled command log, recording periodic checkpoints.
   */
  public run(
    seed: number,
    commands: readonly ReplayCommandInput[],
    options: ReplayOptions = {}
  ): ReplayExecutionResult {
    const ruleVersion = options.ruleVersion ?? '4.1';
    const checkpointInterval = options.checkpointInterval ?? 300;

    const engine = new SimulatorEngine(seed);
    engine.initializeStandardMatch(options.customCompanies);

    // Group commands by submission tick
    const commandMap = new Map<number, EnqueueCommandInput[]>();
    let maxTick = 0;

    for (const item of commands) {
      const submitTick = isReplayCommandEntry(item) ? item.submitAtTick : item.scheduledTick;
      const cmd: EnqueueCommandInput = isReplayCommandEntry(item) ? item.command : item;

      const list = commandMap.get(submitTick) ?? [];
      list.push(cmd);
      commandMap.set(submitTick, list);

      if (submitTick > maxTick) maxTick = submitTick;
      if (cmd.scheduledTick > maxTick) maxTick = cmd.scheduledTick;
    }

    const totalTicks = options.targetTicks ?? Math.max(maxTick + 1, 1);
    const checkpoints: ReplayCheckpoint[] = [];

    // Capture initial checkpoint at tick 0
    const initialCanonical = extractCanonicalSimulationState(engine, ruleVersion);
    checkpoints.push({
      tick: 0,
      stateHash: engine.calculateStateHash(),
      checksumSha256: computeStateChecksumSha256(initialCanonical),
      canonicalState: initialCanonical,
    });

    for (let tick = 0; tick < totalTicks; tick += 1) {
      // Submit commands submitted at current tick
      const toSubmit = commandMap.get(tick);
      if (toSubmit) {
        for (const cmd of toSubmit) {
          engine.submitCommand(cmd);
        }
      }

      engine.processTick();
      const currentTick = engine.getCurrentTick();

      // Checkpoint cadence
      if (currentTick % checkpointInterval === 0 || currentTick === totalTicks) {
        const canonical = extractCanonicalSimulationState(engine, ruleVersion);
        checkpoints.push({
          tick: currentTick,
          stateHash: engine.calculateStateHash(),
          checksumSha256: computeStateChecksumSha256(canonical),
          canonicalState: canonical,
        });
      }
    }

    const finalCanonical = extractCanonicalSimulationState(engine, ruleVersion);
    const finalStateHash = engine.calculateStateHash();
    const finalChecksumSha256 = computeStateChecksumSha256(finalCanonical);

    return {
      seed,
      ruleVersion,
      totalTicks,
      finalStateHash,
      finalChecksumSha256,
      checkpoints,
      finalCanonicalState: finalCanonical,
    };
  }

  /**
   * Verify two replay execution results, returning any mismatched checkpoints and field differences.
   */
  public verify(
    expected: ReplayExecutionResult,
    actual: ReplayExecutionResult
  ): ReplayVerificationOutcome {
    const mismatchedCheckpoints: Array<{
      tick: number;
      expectedHash: string;
      actualHash: string;
      expectedChecksum: string;
      actualChecksum: string;
    }> = [];

    const expectedMap = new Map(expected.checkpoints.map((c) => [c.tick, c]));
    for (const actCp of actual.checkpoints) {
      const expCp = expectedMap.get(actCp.tick);
      if (
        expCp &&
        (expCp.stateHash !== actCp.stateHash || expCp.checksumSha256 !== actCp.checksumSha256)
      ) {
        mismatchedCheckpoints.push({
          tick: actCp.tick,
          expectedHash: expCp.stateHash,
          actualHash: actCp.stateHash,
          expectedChecksum: expCp.checksumSha256,
          actualChecksum: actCp.checksumSha256,
        });
      }
    }

    const differences = diffCanonicalStates(
      expected.finalCanonicalState,
      actual.finalCanonicalState
    );

    const isMatch =
      expected.finalChecksumSha256 === actual.finalChecksumSha256 &&
      mismatchedCheckpoints.length === 0 &&
      differences.length === 0;

    return {
      isMatch,
      differences,
      mismatchedCheckpoints,
    };
  }
}
