/**
 * Golden fixture harness for specs S5 and S9 of issue #10.
 *
 * Shape of the work:
 * - `scenarios.ts` declares the named scenarios: a literal seed, the companies
 *   of the match, a fixed command/tick script and the checkpoint ticks.
 * - `runScenario` rebuilds a scenario on a fresh `SimulatorEngine` and captures
 *   the deepest observable state it can reach through the public API.
 * - `canonicalJson` serializes that state canonically: object keys sorted,
 *   safe integers only (`-0` folded to `0`), no `Date.now()`, no absolute paths
 *   and no dependence on Map/Set iteration order.
 * - `golden-runner.test.ts` asserts (a) two in-process runs are byte-identical
 *   (S9) and (b) the committed fixture matches exactly (S5).
 *
 * Regenerating fixtures is an explicit opt-in; a plain run and CI never write:
 *
 *     GOLDEN_UPDATE=1 bun test tests/golden
 *
 * Captured state (everything reachable from the public engine surface):
 * the `SimulationSnapshot` produced by `createSnapshot()` (tick, engine
 * `stateHash`, every company with credits / energy / grid / reputation /
 * full inventory / every production line and its active batch, every contract
 * with escrow and delivery fields, the global project), the per-company
 * `calculateNetWorth` breakdown, the pending command-queue count, the queue's
 * accepted idempotency keys and the complete command execution history.
 *
 * A final-only snapshot can hide a mid-run divergence that reconverges, so the
 * fixture also records two compact histories: `tick=<stateHash>` samples at the
 * scenario's digest cadence, and a run-length encoded per-line status timeline
 * (`R27N3P11` = running 27 ticks, starved for 3, paused for 11). Any behavioural
 * change on any tick therefore changes the committed bytes.
 *
 * Deliberately NOT captured, because no public accessor reaches it:
 * - the `Mulberry32PRNG` internal state: `rng` is a private engine field and the
 *   engine never consumes it, so the seed is not observable from outside;
 * - the command queue's pending command payloads: only `getPendingCount()` is
 *   public, and every scenario drains its queue (asserted after each run);
 * - the processed idempotency-key set contents: captured indirectly through
 *   `isIdempotencyKeyUsed` probes over the keys the script submitted.
 *
 * Scenarios are tests-only: nothing here changes engine behaviour, and a failing
 * assertion must be reported, never silenced by editing `src/`.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import type {
  CommandExecutionResult,
  CompanyNetWorthBreakdown,
  CompanyState,
  DistributiveOmit,
  EnqueueCommandInput,
  GlobalProjectState,
  IndustrialClass,
  ItemId,
  LineStatus,
  SupplyContract,
} from '../../src/domain/types.ts';

/** Command payload without the three fields the harness fills in itself. */
export type CommandPayload = DistributiveOmit<
  EnqueueCommandInput,
  'commandId' | 'idempotencyKey' | 'scheduledTick'
>;

export interface ScenarioCompany {
  readonly id: string;
  readonly name: string;
  readonly industrialClass: IndustrialClass;
  readonly isNPC: boolean;
}

export interface ScenarioStep {
  /** Tick at which the commands are queued, i.e. executed by `processTick()`. */
  readonly tick: number;
  readonly label: string;
  readonly commands?: readonly CommandPayload[];
}

export interface Scenario {
  readonly name: string;
  readonly note: string;
  readonly seed: number;
  readonly totalTicks: number;
  /** Ticks whose state is captured and compared across runs (S9 only). */
  readonly checkpoints: readonly number[];
  readonly companies: readonly ScenarioCompany[];
  /** Fixed literal preconditions applied through `getCompany` before tick 1. */
  readonly setup?: (engine: SimulatorEngine) => void;
  readonly steps: readonly ScenarioStep[];
}

/** Everything a golden fixture records about one finished replay. */
export interface GoldenFullState {
  readonly tick: number;
  readonly stateHash: string;
  readonly globalProject: GlobalProjectState;
  readonly companies: readonly CompanyState[];
  readonly contracts: readonly SupplyContract[];
  readonly netWorth: readonly CompanyNetWorthBreakdown[];
  readonly pendingCommandCount: number;
  readonly acceptedIdempotencyKeys: readonly string[];
  readonly executionHistory: readonly CommandExecutionResult[];
}

export interface ScenarioRun {
  readonly engine: SimulatorEngine;
  readonly finalState: GoldenFullState;
  /** Canonical bytes of `finalState`. */
  readonly finalBytes: string;
  /** Canonical bytes of the state observed at each requested checkpoint tick. */
  readonly checkpointBytes: ReadonlyMap<number, string>;
  /** `tick=stateHash` samples taken at the scenario's digest cadence. */
  readonly digestEntries: readonly string[];
  /** Run-length encoded per-line status history, one entry per production line. */
  readonly lineStatusTimeline: readonly string[];
  readonly submittedCommands: number;
}

/**
 * How often the replay records a `stateHash` sample. Short scenarios digest
 * every tick so a one-tick divergence cannot hide; long replays digest every
 * tenth tick to keep the fixture small.
 */
export function digestInterval(totalTicks: number): number {
  return totalTicks <= 120 ? 1 : 10;
}

/** One-letter production-line status codes, used by the fixture timeline. */
const STATUS_CODES: Record<LineStatus, string> = {
  IDLE: 'I',
  RUNNING: 'R',
  PAUSED: 'P',
  NO_ENERGY: 'N',
};

/** Ticks per timeline chunk, so no fixture line grows without bound. */
const STATUS_WINDOW = 100;

/**
 * Run-length encode a status history, e.g. `R27N3P11` = running 27 ticks, then
 * starved for 3, then paused for 11. Chunks of `STATUS_WINDOW` ticks are joined
 * with single spaces so long replays stay readable.
 */
function encodeStatusHistory(history: readonly LineStatus[]): string {
  const chunks: string[] = [];

  for (let start = 0; start < history.length; start += STATUS_WINDOW) {
    const window = history.slice(start, start + STATUS_WINDOW);
    let chunk = '';
    let current = window[0]!;
    let count = 0;
    for (const status of window) {
      if (status === current) {
        count += 1;
        continue;
      }
      chunk += `${STATUS_CODES[current]}${count}`;
      current = status;
      count = 1;
    }
    chunks.push(`${chunk}${STATUS_CODES[current]}${count}`);
  }

  return chunks.join(' ');
}

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

type Normalized =
  | null
  | boolean
  | number
  | string
  | Normalized[]
  | { [key: string]: Normalized };

/** Objects/arrays whose compact rendering fits this budget stay on one line. */
const INLINE_BUDGET = 200;

function normalize(value: unknown, path: string): Normalized {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number': {
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`[golden] ${path} must be a safe integer, received ${String(value)}`);
      }
      return value === 0 ? 0 : value; // folds -0 so bytes cannot depend on sign of zero
    }
    case 'object': {
      if (Array.isArray(value)) {
        return value.map((item, index) => normalize(item, `${path}[${index}]`));
      }
      const source = value as Record<string, unknown>;
      const result: { [key: string]: Normalized } = {};
      for (const key of Object.keys(source).sort()) {
        const child = source[key];
        if (child === undefined) {
          continue; // optional fields that were never set carry no information
        }
        result[key] = normalize(child, `${path}.${key}`);
      }
      return result;
    }
    default:
      throw new TypeError(`[golden] ${path} has unsupported type ${typeof value}`);
  }
}

function emit(value: Normalized, level: number): string {
  const compact = JSON.stringify(value);
  if (compact.length <= INLINE_BUDGET) {
    return compact;
  }

  const pad = '  '.repeat(level + 1);
  const close = '  '.repeat(level);

  if (Array.isArray(value)) {
    const items = value.map((item) => `${pad}${emit(item, level + 1)}`);
    return `[\n${items.join(',\n')}\n${close}]`;
  }

  // Only non-null objects reach this branch: scalars always fit the budget.
  const record = value as { [key: string]: Normalized };
  const keys = Object.keys(record).sort();
  const entries = keys.map((key) => `${pad}${JSON.stringify(key)}: ${emit(record[key]!, level + 1)}`);
  return `{\n${entries.join(',\n')}\n${close}}`;
}

/**
 * Canonical, deterministic JSON text for any captured state. Two equal states
 * always produce identical bytes, regardless of key insertion or Map order.
 */
export function canonicalJson(value: unknown): string {
  return `${emit(normalize(value, '$'), 0)}\n`;
}

/**
 * First line where two canonical documents differ, for actionable failures.
 * Line numbers are 1-based so they can be pasted into an editor.
 */
export function firstDivergence(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const limit = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < limit; index += 1) {
    const left = expectedLines[index];
    const right = actualLines[index];
    if (left !== right) {
      return [
        `first divergence at line ${index + 1} `,
        `(fixture has ${expectedLines.length} lines, run has ${actualLines.length}):`,
        `- fixture: ${left ?? '<end of file>'}`,
        `+ run:     ${right ?? '<end of file>'}`,
      ].join('\n');
    }
  }

  return 'documents are line-identical but differ in trailing bytes';
}

// ---------------------------------------------------------------------------
// State capture and scenario replay
// ---------------------------------------------------------------------------

/** Replace a company's whole stock with exactly the given amounts. */
export function setInventory(
  engine: SimulatorEngine,
  companyId: string,
  stock: Partial<Record<ItemId, number>>,
): void {
  const company = engine.getCompany(companyId);
  assert.ok(company, `company ${companyId} must exist before seeding inventory`);
  for (const itemId of Object.keys(company.inventory) as ItemId[]) {
    company.inventory[itemId].available = stock[itemId] ?? 0;
    company.inventory[itemId].reserved = 0;
  }
}

/** Pin the electric grid so energy accounting is explicit in the fixture. */
export function setGrid(engine: SimulatorEngine, companyId: string, energy: number, generation: number): void {
  const company = engine.getCompany(companyId);
  assert.ok(company, `company ${companyId} must exist before pinning the grid`);
  company.energy = energy;
  company.energyGenerationPerTick = generation;
}

/**
 * Deepest state the public API can reach. `createSnapshot()` already returns
 * JSON deep copies, so nothing here aliases live engine internals.
 */
export function captureFullState(
  engine: SimulatorEngine,
  submittedKeys: readonly string[],
): GoldenFullState {
  const snapshot = engine.createSnapshot();
  const queue = engine.getCommandQueue();

  const companies = Object.keys(snapshot.companies)
    .sort()
    .map((companyId) => snapshot.companies[companyId]!);
  const contracts = Object.keys(snapshot.contracts)
    .sort()
    .map((contractId) => snapshot.contracts[contractId]!);

  return {
    tick: snapshot.tick,
    stateHash: snapshot.stateHash,
    globalProject: snapshot.globalProject,
    companies,
    contracts,
    netWorth: companies.map((company) => engine.calculateNetWorth(company.companyId)),
    pendingCommandCount: queue.getPendingCount(),
    acceptedIdempotencyKeys: submittedKeys.filter((key) => queue.isIdempotencyKeyUsed(key)),
    executionHistory: engine.getExecutionHistory(),
  };
}

/**
 * Rebuild a scenario from its literal seed and script on a fresh engine and
 * capture the state at every checkpoint and at the end of the run.
 */
export function runScenario(scenario: Scenario): ScenarioRun {
  assert.ok(Number.isSafeInteger(scenario.seed), `scenario ${scenario.name}: seed must be a safe integer`);
  assert.ok(scenario.companies.length >= 2, `scenario ${scenario.name}: needs at least two companies`);

  const engine = new SimulatorEngine(scenario.seed);
  engine.initializeStandardMatch(scenario.companies.map((company) => ({ ...company })));
  scenario.setup?.(engine);

  const stepsByTick = new Map<number, ScenarioStep[]>();
  for (const step of scenario.steps) {
    assert.ok(
      Number.isSafeInteger(step.tick) && step.tick >= 1 && step.tick <= scenario.totalTicks,
      `scenario ${scenario.name}: step "${step.label}" must be scheduled inside 1..${scenario.totalTicks}`,
    );
    const bucket = stepsByTick.get(step.tick) ?? [];
    bucket.push(step);
    stepsByTick.set(step.tick, bucket);
  }

  const checkpointTicks = new Set(scenario.checkpoints);
  const checkpointBytes = new Map<number, string>();
  const digestEntries: string[] = [];
  const digestEvery = digestInterval(scenario.totalTicks);
  const lineStatusHistory = new Map<string, LineStatus[]>();
  const submittedKeys: string[] = [];
  let submittedCommands = 0;

  for (let tick = 1; tick <= scenario.totalTicks; tick += 1) {
    for (const step of stepsByTick.get(tick) ?? []) {
      for (const payload of step.commands ?? []) {
        submittedCommands += 1;
        const command = {
          ...payload,
          commandId: `cmd_${scenario.name}_${submittedCommands}`,
          idempotencyKey: `idem_${scenario.name}_${submittedCommands}`,
          scheduledTick: tick,
        } as EnqueueCommandInput;
        assert.equal(
          engine.submitCommand(command),
          true,
          `scenario ${scenario.name}: command "${step.label}" (${payload.type}) must be accepted`,
        );
        submittedKeys.push(command.idempotencyKey);
      }
    }

    engine.processTick();

    if ((tick - 1) % digestEvery === 0 || tick === scenario.totalTicks) {
      digestEntries.push(`${tick}=${engine.calculateStateHash()}`);
    }

    const companiesThisTick = [...engine.getAllCompanies()].sort((left, right) =>
      left.companyId.localeCompare(right.companyId),
    );
    for (const company of companiesThisTick) {
      const lines = [...company.lines].sort((left, right) => left.lineId.localeCompare(right.lineId));
      for (const line of lines) {
        const key = `${company.companyId}/${line.lineId}`;
        const history = lineStatusHistory.get(key) ?? [];
        history.push(line.status);
        lineStatusHistory.set(key, history);
      }
    }

    if (checkpointTicks.has(tick)) {
      checkpointBytes.set(tick, canonicalJson(captureFullState(engine, submittedKeys)));
    }
  }

  const finalState = captureFullState(engine, submittedKeys);

  // Replay invariants: the script must have fully drained into the engine, so a
  // fixture can never hide queued work that a later tick would still apply.
  assert.equal(
    finalState.pendingCommandCount,
    0,
    `scenario ${scenario.name}: the queue must be drained at the end of the run`,
  );
  assert.equal(
    finalState.executionHistory.length,
    submittedCommands,
    `scenario ${scenario.name}: every submitted command must have executed`,
  );
  assert.equal(
    finalState.acceptedIdempotencyKeys.length,
    submittedCommands,
    `scenario ${scenario.name}: every submitted idempotency key must be known to the queue`,
  );
  assert.equal(
    finalState.tick,
    scenario.totalTicks,
    `scenario ${scenario.name}: final tick must equal the declared length`,
  );

  return {
    engine,
    finalState,
    finalBytes: canonicalJson(finalState),
    checkpointBytes,
    digestEntries,
    lineStatusTimeline: [...lineStatusHistory.keys()]
      .sort()
      .map((key) => `${key} ${encodeStatusHistory(lineStatusHistory.get(key)!)}`),
    submittedCommands,
  };
}

/** Group digest samples into fixture lines of `perLine` ticks each. */
function chunkDigest(entries: readonly string[], perLine = 8): string[] {
  const lines: string[] = [];
  for (let index = 0; index < entries.length; index += perLine) {
    lines.push(entries.slice(index, index + perLine).join(' '));
  }
  return lines;
}

/**
 * The committed fixture document for one scenario (canonical bytes): the
 * scenario metadata, the sampled `tick=stateHash` digest and the full final
 * state. Any behavioural change on any digested tick changes this document.
 */
export function goldenDocument(scenario: Scenario, run: ScenarioRun): string {
  return canonicalJson({
    note: scenario.note,
    scenario: scenario.name,
    seed: scenario.seed,
    totalTicks: scenario.totalTicks,
    digestEvery: digestInterval(scenario.totalTicks),
    tickDigest: chunkDigest(run.digestEntries),
    lineStatusTimeline: run.lineStatusTimeline,
    finalState: run.finalState,
  });
}

export const UPDATE_FIXTURES = process.env.GOLDEN_UPDATE === '1';

export function goldenFixtureFile(scenarioName: string): string {
  return fileURLToPath(new URL(`./fixtures/${scenarioName}.json`, import.meta.url));
}

/** Scenario names that currently have a committed fixture, without the suffix. */
export function listGoldenFixtures(): string[] {
  const directory = fileURLToPath(new URL('./fixtures/', import.meta.url));
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length))
    .sort();
}

/**
 * Read the committed fixture. Only the explicit `GOLDEN_UPDATE=1` opt-in writes;
 * a normal run, and therefore CI, never touches the working tree.
 */
export function loadGoldenFixture(scenarioName: string, document: string): string {
  const file = goldenFixtureFile(scenarioName);

  if (UPDATE_FIXTURES) {
    mkdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url)), { recursive: true });
    writeFileSync(file, document, 'utf8');
    return document;
  }

  assert.ok(
    existsSync(file),
    `missing golden fixture ${scenarioName}.json; regenerate with: GOLDEN_UPDATE=1 bun test tests/golden`,
  );
  return readFileSync(file, 'utf8');
}
