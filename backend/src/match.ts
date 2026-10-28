/**
 * Authoritative match wrapper.
 *
 * The match owns exactly one simulation engine instance, the server-selected
 * company, the protocol projections and the per-match command acknowledgement
 * ledger. Clients never receive engine objects; every response is a detached,
 * JSON-safe projection.
 *
 * Durable mode (S3/S6/S8): when a `MatchStore` is injected, the match persists
 * its command queue mirror, permanent idempotency keys, acknowledgement ledger,
 * execution history and match-level counters, and adopts all of them on boot.
 * Without a store it behaves exactly as before, with no database I/O.
 */

import { randomBytes } from 'node:crypto';

import { getRecipe, getRecipeProfile } from '../../src/domain/recipeCatalog.ts';
import type { CompanyState, IndustrialClass, RecipeId } from '../../src/domain/types.ts';
import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import {
  CommandNotAccepted,
  type AdoptedMatch,
  type MatchStore,
} from '../../src/persistence/matchStore.ts';
import type { MatchMetadataWrite } from '../../src/persistence/repos/index.ts';

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
  /** Mirror of the engine's queue sequence counter, so restarts stay monotonic. */
  private sequenceCounter = 0;
  /**
   * Highest tick the database has ever recorded for this match. Until T4
   * hydrates the engine, a restarted process rebuilds the simulation at tick 0,
   * so the persisted tick is written as `max(floor, engine tick)` and can never
   * go backwards (risk item 1: stored data must not be silently lost).
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
    this.sequenceCounter = boot.metadata.sequenceCounter;
    this.historyCursor = boot.metadata.historyCursor;
    this.tickFloor = boot.metadata.currentTick;
    this.restoreBookkeeping(boot);
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
      const nextSequence = this.sequenceCounter + 1;
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
            // The whole command body, so a restore rebuilds it exactly.
            payloadJson: JSON.stringify(command),
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
      this.sequenceCounter = nextSequence;
    } else if (!this.engine.submitCommand(command)) {
      // Defensive: the ledger above already guarantees one command per request.
      return { kind: 'request_id_reused' };
    }

    this.requestLedger.set(input.requestId, { fingerprint, commandId });
    this.commandRecords.set(commandId, { commandId, status: 'queued' });
    return { kind: 'queued', commandId };
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
      sequenceCounter: overrides.sequenceCounter ?? this.sequenceCounter,
      historyCursor: overrides.historyCursor ?? this.historyCursor,
      tickIntervalMs: this.tickIntervalMs,
    };
  }

  /**
   * Fold one tick of engine execution history into the match bookkeeping and
   * persist it.
   *
   * Ordering and consistency: the durable write runs first and the in-memory
   * fold second, so memory never holds a status the database refused (see
   * `MatchStore`). The cursor is monotonic (`Math.max`): a restarted engine
   * starts with an empty history while the persisted cursor still points past
   * the results already recorded, and re-folding from zero would append rows a
   * second time — the duplicate movement S8 forbids. Hydrating the engine's own
   * history is T4; until then the persisted cursor is the floor.
   */
  private commitTickProgress(): void {
    const history = this.engine.getExecutionHistory();
    const folded = history.slice(this.historyCursor);
    const nextCursor = Math.max(this.historyCursor, history.length);

    if (this.store) {
      this.store.commitExecutions({
        metadata: this.snapshotMetadata({ historyCursor: nextCursor }),
        results: folded.map((result, offset) => ({
          matchId: this.matchId,
          historyIndex: this.historyCursor + offset,
          ...result,
        })),
        completedCommandIds: folded.map((result) => result.commandId),
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
