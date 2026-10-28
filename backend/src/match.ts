/**
 * Authoritative match wrapper.
 *
 * The match owns exactly one simulation engine instance, the server-selected
 * company, the protocol projections and the per-match command acknowledgement
 * ledger. Clients never receive engine objects; every response is a detached,
 * JSON-safe projection.
 *
 * Durable mode (S3/S6/S8/S5): when a `MatchStore` is injected, the match
 * persists its command queue mirror, permanent idempotency keys,
 * acknowledgement ledger, execution history, engine snapshot (companies with
 * inventory and lines, contracts) and match-level counters, and adopts all of
 * them on boot. Without a store it behaves exactly as before, with no database
 * I/O.
 */

import { randomBytes } from 'node:crypto';

import { getRecipe, getRecipeProfile } from '../../src/domain/recipeCatalog.ts';
import type {
  CommandExecutionResult,
  CompanyState,
  GameCommand,
  IndustrialClass,
  RecipeId,
} from '../../src/domain/types.ts';
import {
  deriveGlobalProjectState,
  SimulatorEngine,
  type EngineHydration,
} from '../../src/engine/SimulatorEngine.ts';
import {
  CommandNotAccepted,
  type AdoptedMatch,
  type MatchStore,
} from '../../src/persistence/matchStore.ts';
import type {
  CommandResultRecord,
  MatchMetadataWrite,
  QueuedCommandRecord,
} from '../../src/persistence/repos/index.ts';
import { runAtomic } from '../../src/persistence/transaction.ts';

export const PROTOCOL_VERSION = 1;
export const SERVER_COMPANY_ID = 'comp_metal_01';
export const SUPPORTED_RECIPE_ID = 'R1' as const;
export const DEFAULT_TICK_INTERVAL_MS = 1000;
/** Seed of a match started without an explicit one (unchanged default). */
export const DEFAULT_MATCH_SEED = 42107;
/** Maximum unique command acknowledgements retained per match. */
export const MAX_ACKNOWLEDGED_REQUESTS = 1024;

export interface RecipeProjection {
  readonly id: RecipeId;
  readonly name: string;
  readonly inputs: ReadonlyArray<{ readonly itemId: string; readonly quantity: number }>;
  readonly outputItem: string;
  readonly outputQuantity: number;
  readonly durationTicks: number;
  readonly energyCost: number;
}

export interface StatePayload {
  readonly protocolVersion: number;
  readonly matchId: string;
  readonly tick: number;
  readonly tickIntervalMs: number;
  readonly company: CompanyState;
  readonly recipes: ReadonlyArray<RecipeProjection>;
}

export type CommandStatus = 'queued' | 'executed' | 'rejected';

export interface CommandStatusView {
  commandId: string;
  status: CommandStatus;
  executedAtTick?: number;
  errorCode?: string;
}

/** Validated shape of `POST /v1/production`. */
export interface ProductionRequestInput {
  readonly requestId: string;
  readonly lineId: string;
  readonly recipeId: string;
}

/** Outcome of a production request, mapped to HTTP by the transport layer. */
export type ProductionDecision =
  | { readonly kind: 'queued'; readonly commandId: string }
  | { readonly kind: 'unsupported_recipe' }
  | { readonly kind: 'line_not_owned' }
  | { readonly kind: 'request_id_reused' }
  | { readonly kind: 'command_limit' };

export interface FactoryMatchOptions {
  readonly seed?: number;
  readonly matchId?: string;
  readonly tickIntervalMs?: number;
  /**
   * Durable match state. Omitted keeps the match purely in memory with no
   * database I/O at all (the pre-persistence behaviour, byte-identical).
   */
  readonly store?: MatchStore;
}

function createMatchId(): string {
  return `match_${randomBytes(8).toString('hex')}`;
}

/**
 * Rebuild a `GameCommand` from its queue row.
 *
 * The row carries the whole body as JSON (T3 chose `payload_json` for the
 * polymorphic command) *and* the columns that identify it. They must agree: a
 * mismatched row is corruption, and restoring it silently would execute a
 * command nobody submitted.
 *
 * Tolerance, deliberately narrow: T3 wrote the payload before the engine
 * assigned the sequence number, so rows created by that release have no
 * `sequenceNumber` in the body. The row column is then authoritative. A payload
 * that *does* carry a different number is still refused.
 */
function parseStoredCommand(row: QueuedCommandRecord): GameCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payloadJson);
  } catch (error) {
    throw new Error(`Corrupt payload JSON for queued command "${row.commandId}"`, { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`Queued command "${row.commandId}" does not hold a command body`);
  }

  const command = parsed as Partial<GameCommand> & { readonly sequenceNumber?: number };
  if (
    command.commandId !== row.commandId ||
    command.companyId !== row.companyId ||
    command.type !== row.commandType ||
    command.idempotencyKey !== row.idempotencyKey ||
    command.scheduledTick !== row.scheduledTick ||
    (command.sequenceNumber !== undefined && command.sequenceNumber !== row.sequenceNumber)
  ) {
    throw new Error(
      `Queued command "${row.commandId}" disagrees with its queue row; refusing to restore it`,
    );
  }
  return { ...command, sequenceNumber: row.sequenceNumber } as GameCommand;
}

/**
 * `match_command_results` row -> engine execution result. Optional failure
 * fields are omitted rather than set to `undefined`, so a hydrated history is a
 * deep equal of the history that produced the rows.
 */
function toExecutionResult(row: CommandResultRecord): CommandExecutionResult {
  return {
    commandId: row.commandId,
    idempotencyKey: row.idempotencyKey,
    executedAtTick: row.executedAtTick,
    success: row.success,
    ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
    ...(row.errorMessage === undefined ? {} : { errorMessage: row.errorMessage }),
  };
}

function projectRecipe(recipeId: RecipeId, industrialClass: IndustrialClass): RecipeProjection {
  const recipe = getRecipe(recipeId);
  const profile = getRecipeProfile(recipeId, industrialClass);
  return {
    id: recipe.id,
    name: recipe.name,
    inputs: recipe.inputs.map((input) => ({ itemId: input.itemId, quantity: input.quantity })),
    outputItem: recipe.outputItem,
    outputQuantity: recipe.outputQuantity,
    durationTicks: profile.durationTicks,
    energyCost: profile.energyCost,
  };
}

export class FactoryMatch {
  public readonly matchId: string;
  public readonly tickIntervalMs: number;
  public readonly engine: SimulatorEngine;

  /** requestId -> acknowledged command and its payload fingerprint. */
  private readonly requestLedger = new Map<string, { fingerprint: string; commandId: string }>();
  /** commandId -> latest known command status. */
  private readonly commandRecords = new Map<string, CommandStatusView>();
  /** Number of engine execution results already folded into command records. */
  private historyCursor = 0;

  /** Durable match state, or null when persistence is disabled. */
  private readonly store: MatchStore | null;
  /** Seed the engine was constructed with (also the persisted match seed). */
  private readonly seed: number;
  /**
   * Persisted `matches.sequence_counter`, used as a monotonic floor. The live
   * value is read from the engine queue instead of being mirrored here: the
   * queue is the only place that hands numbers out, so an admission path that
   * bypasses `requestProduction` cannot make the row and the engine disagree.
   */
  private sequenceFloor = 0;
  /**
   * Highest tick the database has ever recorded for this match. It is both the
   * floor of `matches.current_tick` (never written backwards, risk item 1) and,
   * since T4, the tick the engine is hydrated with — a restarted process no
   * longer resumes at tick 0 while the stored tick keeps climbing.
   */
  private tickFloor = 0;

  constructor(options: FactoryMatchOptions = {}) {
    this.store = options.store ?? null;
    const requestedSeed = options.seed ?? DEFAULT_MATCH_SEED;
    const requestedTickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;

    // Adoption has to run before the engine exists: a persisted match decides
    // its own seed and tick interval, and the engine is seeded from it.
    const boot = this.store
      ? this.store.adoptOrCreate({
          seed: requestedSeed,
          tickIntervalMs: requestedTickIntervalMs,
          ...(options.matchId === undefined ? {} : { matchId: options.matchId }),
        })
      : null;

    this.seed = boot?.metadata.seed ?? requestedSeed;
    this.engine = new SimulatorEngine(this.seed);
    this.engine.initializeStandardMatch();
    this.matchId = boot?.metadata.matchId ?? options.matchId ?? createMatchId();
    this.tickIntervalMs = boot?.metadata.tickIntervalMs ?? requestedTickIntervalMs;

    if (!boot) return;
    this.sequenceFloor = boot.metadata.sequenceCounter;
    this.tickFloor = boot.metadata.currentTick;
    // The cursor is a floor, not a mirror: a restart must never re-fold results
    // the database already recorded (S8).
    this.historyCursor = Math.max(boot.metadata.historyCursor, boot.results.length);
    this.restoreBookkeeping(boot);
    this.restoreEngineState();

    if (!boot.adopted) {
      // A brand new match persists its opening snapshot, so a restart before the
      // first tick still has an engine state to rebuild instead of only rows.
      this.persistEngineSnapshot();
    }
  }

  /**
   * Rebuild the engine from the rows a restart left behind (S5/S9), once and
   * before the clock starts.
   *
   * Fixed order, mirrored by `SimulatorEngine.hydrate`: companies (with their
   * inventory and lines, `activeBatch` included) and contracts → counters and
   * tick → command queue with its permanent keys and sequence counter →
   * execution history. The match-side ledger and cursor are restored by
   * `restoreBookkeeping`; nothing is mirrored twice.
   *
   * Restoring the processed keys is what keeps S8's engine-side dedupe working
   * after a restart (A6, second idempotency store), and restoring the history is
   * what lets the cursor keep folding without re-appending rows it already wrote.
   */
  private restoreEngineState(): void {
    const store = this.store;
    if (!store) return;

    const repositories = store.repositories;
    // `CompanyRecord` carries the two row-audit timestamps. They are row
    // metadata, not simulation state: spreading the record straight into the
    // engine would put `createdAtUtc`/`updatedAtUtc` into engine company objects
    // and make a hydrated match structurally differ from a never-restarted one.
    // They are dropped here, at the single boundary where a row becomes engine
    // state, and the domain fields pass through untouched.
    const companies = repositories.companies.loadAll().map((record) => {
      const { createdAtUtc: _createdAtUtc, updatedAtUtc: _updatedAtUtc, ...company } = record;
      return company;
    });
    const contracts = repositories.contracts.list();
    const pendingRows = repositories.queue.listPending(this.matchId);
    const processedRows = repositories.queue.listProcessed(this.matchId);
    const resultRows = repositories.commandResults.list(this.matchId);

    const commands = pendingRows.map((row) => parseStoredCommand(row));
    const processedIdempotencyKeys = processedRows.map((row) => row.idempotencyKey);
    const sequenceCounter = Math.max(
      this.sequenceFloor,
      ...commands.map((command) => command.sequenceNumber),
    );
    const commandResults = resultRows.map((row) => toExecutionResult(row));
    const queue = { commands, processedIdempotencyKeys, sequenceCounter };

    const hasSnapshot = companies.length > 0;
    if (!hasSnapshot && this.tickFloor > 0) {
      // Documented degraded path: a database written before engine snapshots
      // existed (T1-T3) has no company rows, so the simulation cannot be rebuilt
      // and replaying its pending commands against an invented state would be a
      // fabricated movement. Only the durable counters are restored here; the
      // pending rows stay `queued` and the next tick starts writing snapshots.
      this.engine.hydrate({ queue: { ...queue, commands: [] } });
      return;
    }

    const hydration: EngineHydration = hasSnapshot
      ? {
          currentTick: this.tickFloor,
          companies,
          contracts,
          globalProject: deriveGlobalProjectState(companies),
          queue,
          commandResults,
        }
      : { queue, commandResults };
    this.engine.hydrate(hydration);

    if (this.engine.getGlobalProject().isVictorious) {
      // Company rows give the delivered count but not the completion tick. Loud
      // failure instead of a silently wrong state (open point: persist the
      // global project; unreachable through this backend, which has no command
      // path that delivers Megamachine parts).
      throw new Error(
        `Match "${this.matchId}" is victorious but no persisted row records the completion ` +
          'tick, so its state cannot be reconstructed exactly',
      );
    }
  }

  /**
   * Persist the engine snapshot (S5): every company with its inventory and
   * production lines, plus every contract.
   *
   * Always called inside a transaction owned by the caller (the tick unit of
   * work, or the first boot write), never on its own, so the company rows can
   * never commit ahead of or behind the tick they describe.
   */
  private persistEngineSnapshot(): void {
    const store = this.store;
    if (!store) return;
    for (const company of this.engine.getAllCompanies()) {
      store.repositories.saveCompanyState(company);
    }
    for (const contract of this.engine.getAllContracts()) {
      store.repositories.contracts.save(contract);
    }
  }

  /**
   * Rebuild the match-side ledger, status map and cursor from the rows a
   * restart left behind (S6/S8). Results win over queue rows: a command that
   * already executed must never be reported as `queued` again (A6).
   */
  private restoreBookkeeping(boot: AdoptedMatch): void {
    for (const entry of boot.acknowledged) {
      this.requestLedger.set(entry.requestId, {
        fingerprint: entry.fingerprint,
        commandId: entry.commandId,
      });
    }
    for (const result of boot.results) {
      this.commandRecords.set(result.commandId, {
        commandId: result.commandId,
        status: result.success ? 'executed' : 'rejected',
        executedAtTick: result.executedAtTick,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      });
    }
    for (const pending of boot.pending) {
      if (this.commandRecords.has(pending.commandId)) continue;
      this.commandRecords.set(pending.commandId, {
        commandId: pending.commandId,
        status: 'queued',
      });
    }
  }

  /** Advance the authoritative simulation by one or more discrete ticks. */
  public advanceTicks(count = 1): void {
    for (let index = 0; index < count; index += 1) {
      this.engine.processTick();
      this.commitTickProgress();
    }
  }

  /**
   * Accept one single-batch R1 request for the server-selected company.
   * Validation rejections return before touching the ledger, the queue or the
   * simulation, so they neither enqueue a command nor consume a request ID.
   */
  public requestProduction(input: ProductionRequestInput): ProductionDecision {
    if (input.recipeId !== SUPPORTED_RECIPE_ID) {
      return { kind: 'unsupported_recipe' };
    }

    const company = this.getServerCompany();
    const ownsLine = company.lines.some((line) => line.lineId === input.lineId);
    if (!ownsLine) {
      return { kind: 'line_not_owned' };
    }

    const fingerprint = `${input.lineId}\n${input.recipeId}`;
    const acknowledged = this.requestLedger.get(input.requestId);
    if (acknowledged) {
      if (acknowledged.fingerprint === fingerprint) {
        return { kind: 'queued', commandId: acknowledged.commandId };
      }
      return { kind: 'request_id_reused' };
    }

    if (this.requestLedger.size >= MAX_ACKNOWLEDGED_REQUESTS) {
      return { kind: 'command_limit' };
    }

    const commandId = `cmd_${randomBytes(12).toString('hex')}`;
    const command = {
      commandId,
      companyId: SERVER_COMPANY_ID,
      scheduledTick: this.engine.getCurrentTick() + 1,
      idempotencyKey: `http:${this.matchId}:${input.requestId}`,
      type: 'SET_PRODUCTION_TARGET' as const,
      lineId: input.lineId,
      recipeId: SUPPORTED_RECIPE_ID,
      targetBatches: 1,
    };

    if (this.store) {
      const nextSequence = this.currentSequenceNumber() + 1;
      try {
        this.store.commitCommand({
          metadata: this.snapshotMetadata({ sequenceCounter: nextSequence }),
          command: {
            commandId,
            matchId: this.matchId,
            companyId: command.companyId,
            sequenceNumber: nextSequence,
            scheduledTick: command.scheduledTick,
            idempotencyKey: command.idempotencyKey,
            commandType: command.type,
            // The whole command body, so a restore rebuilds it exactly. The
            // sequence number the engine will assign is included: the engine
            // owns the counter, so the payload and the queue row agree.
            payloadJson: JSON.stringify({ ...command, sequenceNumber: nextSequence }),
          },
          processed: {
            matchId: this.matchId,
            idempotencyKey: command.idempotencyKey,
            commandId,
          },
          acknowledgement: {
            matchId: this.matchId,
            requestId: input.requestId,
            fingerprint,
            commandId,
            capacity: MAX_ACKNOWLEDGED_REQUESTS,
          },
          // Runs last, inside the transaction: the rows exist before the engine
          // observes the command, and a refusal rolls them all back.
          apply: () => this.engine.submitCommand(command),
        });
      } catch (error) {
        if (error instanceof CommandNotAccepted) {
          // Defensive: the ledger above already guarantees one command per request.
          return { kind: 'request_id_reused' };
        }
        throw error;
      }
    } else if (!this.engine.submitCommand(command)) {
      // Defensive: the ledger above already guarantees one command per request.
      return { kind: 'request_id_reused' };
    }

    this.requestLedger.set(input.requestId, { fingerprint, commandId });
    this.commandRecords.set(commandId, { commandId, status: 'queued' });
    return { kind: 'queued', commandId };
  }

  /**
   * Highest sequence number handed out, never below the persisted floor.
   *
   * Reading it from the engine queue keeps `matches.sequence_counter` and
   * `match_command_queue.sequence_number` in agreement even when a command was
   * admitted through the store seam rather than through `requestProduction`.
   */
  private currentSequenceNumber(): number {
    return Math.max(this.sequenceFloor, this.engine.getCommandQueue().getSequenceCounter());
  }

  /** Command status for this match, or undefined when the ID is unknown. */
  public getCommandStatus(commandId: string): CommandStatusView | undefined {
    const record = this.commandRecords.get(commandId);
    if (!record) return undefined;
    const view: CommandStatusView = { commandId: record.commandId, status: record.status };
    if (record.executedAtTick !== undefined) view.executedAtTick = record.executedAtTick;
    if (record.errorCode !== undefined) view.errorCode = record.errorCode;
    return view;
  }

  /** Number of unique acknowledged requests retained by the match. */
  public getAcknowledgedRequestCount(): number {
    return this.requestLedger.size;
  }

  /**
   * Build the full `matches` row snapshot written with every durable change.
   * The counters are spread from memory so one write can never persist a
   * mixture of old and new values.
   */
  private snapshotMetadata(
    overrides: { readonly sequenceCounter?: number; readonly historyCursor?: number } = {},
  ): MatchMetadataWrite {
    return {
      matchId: this.matchId,
      seed: this.seed,
      currentTick: Math.max(this.tickFloor, this.engine.getCurrentTick()),
      sequenceCounter: overrides.sequenceCounter ?? this.currentSequenceNumber(),
      historyCursor: overrides.historyCursor ?? this.historyCursor,
      tickIntervalMs: this.tickIntervalMs,
    };
  }

  /**
   * Fold one tick of engine execution history into the match bookkeeping and
   * persist the whole tick.
   *
   * One transaction (risk item 4) now covers four things: the `matches`
   * counters, the new execution-history rows, the queue rows those results
   * clear, and the engine snapshot (companies, inventory, lines, contracts,
   * S5). A crash can therefore never leave the stored tick ahead of the company
   * rows that describe it, which is the window T3 documented.
   *
   * Ordering and consistency: the durable write runs first and the in-memory
   * fold second, so memory never holds a status the database refused (see
   * `MatchStore`). The cursor stays monotonic (`Math.max`).
   */
  private commitTickProgress(): void {
    const history = this.engine.getExecutionHistory();
    const folded = history.slice(this.historyCursor);
    const nextCursor = Math.max(this.historyCursor, history.length);

    const store = this.store;
    if (store) {
      // `commitExecutions` opens its own unit of work; wrapping it here makes it
      // a savepoint of the tick's transaction (`runAtomic` is nesting-safe).
      runAtomic(store.database, () => {
        store.commitExecutions({
          metadata: this.snapshotMetadata({ historyCursor: nextCursor }),
          results: folded.map((result, offset) => ({
            matchId: this.matchId,
            historyIndex: this.historyCursor + offset,
            ...result,
          })),
          completedCommandIds: folded.map((result) => result.commandId),
        });
        this.persistEngineSnapshot();
      });
    }

    for (const result of folded) {
      const record = this.commandRecords.get(result.commandId);
      if (!record) continue;
      record.status = result.success ? 'executed' : 'rejected';
      record.executedAtTick = result.executedAtTick;
      record.errorCode = result.success ? undefined : result.errorCode;
    }
    this.historyCursor = nextCursor;
  }

  /** The server-selected company, or an invariant failure. */
  public getServerCompany(): CompanyState {
    const company = this.engine.getCompany(SERVER_COMPANY_ID);
    if (!company) {
      throw new Error(`The server-selected company ${SERVER_COMPANY_ID} is missing from the match`);
    }
    return company;
  }

  /** Detached own-company state plus the supported recipe projection. */
  public getStatePayload(): StatePayload {
    const company = this.getServerCompany();
    return {
      protocolVersion: PROTOCOL_VERSION,
      matchId: this.matchId,
      tick: this.engine.getCurrentTick(),
      tickIntervalMs: this.tickIntervalMs,
      company: structuredClone(company),
      recipes: [projectRecipe(SUPPORTED_RECIPE_ID, company.industrialClass)],
    };
  }
}
