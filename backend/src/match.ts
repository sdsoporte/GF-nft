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

import { getRecipe, getRecipeProfile } from './domain/recipeCatalog.ts';
import { NpcController } from './engine/npc/NpcController.ts';
import type {
  CommandExecutionResult,
  CompanyState,
  ContractStatus,
  DistributiveOmit,
  EnqueueCommandInput,
  GameCommand,
  IndustrialClass,
  LinePriority,
  RecipeId,
  SupplyContract,
} from './domain/types.ts';
import {
  deriveGlobalProjectState,
  SimulatorEngine,
  type EngineHydration,
} from './engine/SimulatorEngine.ts';
import { createEngineCreditOpening } from './engine/EngineCreditJournal.ts';
import {
  CommandNotAccepted,
  type AdoptedMatch,
  type MatchStore,
} from './persistence/matchStore.ts';
import type {
  CommandResultRecord,
  MatchMetadataWrite,
  QueuedCommandRecord,
} from './persistence/repos/index.ts';
import { runAtomic } from './persistence/transaction.ts';

export const PROTOCOL_VERSION = 1;
export const SERVER_COMPANY_ID = 'comp_metal_01';
export const SUPPORTED_RECIPE_ID = 'R1' as const;
export const DEFAULT_TICK_INTERVAL_MS = 1000;
/** Seed of a match started without an explicit one (unchanged default). */
export const DEFAULT_MATCH_SEED = 42107;
/** Maximum unique command acknowledgements retained per match. */
export const MAX_ACKNOWLEDGED_REQUESTS = 1024;
/** Command outcomes the seller read model reports, newest last. */
export const SELLING_HISTORY_LIMIT = 25;

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

/**
 * One tradable supply offer as the player sees it (issue #58).
 *
 * Read-only visibility only: the projection carries the terms of the offer and
 * never a command, a control or an engine object.
 */
export interface MarketOfferProjection {
  readonly contractId: string;
  readonly sellerCompanyId: string;
  readonly buyerCompanyId: string | null;
  readonly itemId: string;
  readonly quantity: number;
  readonly unitPriceCredits: number;
  readonly totalValueCredits: number;
  readonly createdAtTick: number;
  readonly deadlineTick: number;
}

/** `GET /v1/market/offers`: the public book plus the tick it describes. */
export interface MarketOffersPayload {
  readonly tick: number;
  readonly offers: ReadonlyArray<MarketOfferProjection>;
}

/** One contract of the server-selected company (issue #58). */
export interface ContractProjection {
  readonly contractId: string;
  readonly sellerCompanyId: string;
  readonly buyerCompanyId: string;
  readonly itemId: string;
  readonly totalQuantity: number;
  readonly deliveredQuantity: number;
  readonly unitPriceCredits: number;
  readonly totalValueCredits: number;
  readonly collateralSellerCredits: number;
  readonly createdAtTick: number;
  readonly deadlineTick: number;
  readonly status: ContractStatus;
  /** Explicit absence instead of an omitted key: `null` until settlement. */
  readonly settledAtTick: number | null;
}

/** `GET /v1/contracts`: the own-contract list plus the tick it describes. */
export interface ContractsPayload {
  readonly tick: number;
  readonly companyId: string;
  readonly contracts: ReadonlyArray<ContractProjection>;
}

/**
 * Engine-owned figures a human must see before approving a financial command
 * (issue #58, milestone B). They are derived from the stored contract and the
 * engine's own constants; this projection adds no rule and decides nothing.
 */
export interface SellingConsequences {
  /** Buyer funds the engine locks when the offer is accepted (100% of value). */
  readonly buyerEscrowCredits: number;
  /** Seller funds the engine locks when the offer is accepted (20% of value). */
  readonly sellerCollateralCredits: number;
  /** Market fee the settlement withholds from delivered value (2%). */
  readonly marketFeeCredits: number;
  /** What the seller keeps when every unit is delivered. */
  readonly sellerNetOnFullDeliveryCredits: number;
  /** Credits the seller forfeits per undelivered unit on default. */
  readonly penaltyPerMissingUnitCredits: number;
  /** Most the seller can lose on default: the smaller of collateral and penalty. */
  readonly maximumDefaultIndemnityCredits: number;
}

/** One own contract plus the consequences of publishing, shipping or defaulting. */
export interface SellingContractProjection extends Omit<ContractProjection, 'buyerCompanyId'> {
  /** `null` while the offer is open; the designated buyer once it is targeted. */
  readonly buyerCompanyId: string | null;
  readonly consequences: SellingConsequences;
}

/** One admitted command of the acting company, correlated by its caller key. */
export interface SellingCommandOutcome {
  readonly idempotencyKey: string;
  readonly status: 'executed' | 'rejected';
  readonly executedAtTick: number;
  readonly errorCode: string | null;
}

/**
 * `GET /v1/owner/selling`: the owner-session read model of the seller loop.
 *
 * It exists because the writing routes cannot read themselves back: the engine
 * assigns `contractId` while executing a queued draft, and escrow, collateral,
 * fee and indemnity are engine state. Nothing here is public market data and
 * nothing here is a new economic rule.
 */
export interface OwnerSellingPayload {
  readonly tick: number;
  readonly companyId: string;
  readonly availableCredits: number;
  readonly marketFeeBps: number;
  readonly contracts: ReadonlyArray<SellingContractProjection>;
  readonly recentCommands: ReadonlyArray<SellingCommandOutcome>;
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

/**
 * Durable admission outcome shared by every player write route.
 *
 * The transport maps each kind to one entry of the frozen error table, so the
 * line controls of issue #57 answer with exactly the semantics `/v1/production`
 * already has.
 */
export type AdmissionDecision =
  | { readonly kind: 'queued'; readonly commandId: string }
  | { readonly kind: 'line_not_owned' }
  | { readonly kind: 'request_id_reused' }
  | { readonly kind: 'command_limit' };

/** Outcome of a production request, mapped to HTTP by the transport layer. */
export type ProductionDecision = AdmissionDecision | { readonly kind: 'unsupported_recipe' };

/** The player-facing line controls (issue #57). */
export type LineControlAction = 'pause' | 'resume' | 'priority';

/**
 * Validated shape of `POST /v1/lines/{lineId}/{pause|resume|priority}`.
 *
 * The company, the tick and the sequence number are server-owned, exactly as on
 * the production route: they cannot appear here. A discriminated union keeps
 * the priority action from being admitted without its value.
 */
export type LineControlRequestInput =
  | {
      readonly requestId: string;
      readonly lineId: string;
      readonly action: 'pause' | 'resume';
    }
  | {
      readonly requestId: string;
      readonly lineId: string;
      readonly action: 'priority';
      readonly priority: LinePriority;
    };

/** A command body minus every field the server owns. */
type PlayerCommandBody = DistributiveOmit<
  EnqueueCommandInput,
  'commandId' | 'companyId' | 'scheduledTick' | 'idempotencyKey'
>;

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
    ...(row.companyId === undefined ? {} : { companyId: row.companyId }),
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

/**
 * Issue #58: what makes an offer tradable right now.
 *
 * `PENDING` only (a `DRAFT` is its creator's private business) and unexpired,
 * using the same absolute-tick predicate the NPC policy and the engine's own
 * dispatch checks use: an offer dies once `currentTick` reaches its deadline.
 */
function isTradableOffer(contract: SupplyContract, currentTick: number): boolean {
  return contract.status === 'PENDING' && contract.deadlineTick > currentTick;
}

/**
 * Issue #58: the visibility rule the MCP `get_contracts` tool already applies.
 *
 * A contract is own when the company is its seller or its buyer; a `DRAFT` is
 * own only for its seller, so a foreign draft never reaches the player.
 */
function isOwnContract(contract: SupplyContract, companyId: string): boolean {
  return (
    (contract.sellerCompanyId === companyId || contract.buyerCompanyId === companyId) &&
    (contract.status !== 'DRAFT' || contract.sellerCompanyId === companyId)
  );
}

/**
 * Financial consequences of one contract, read from the stored record and the
 * engine's own fee constant. Default indemnity follows the engine settlement:
 * the smaller of the seller collateral and the penalty for the missing units.
 */
function sellingConsequences(contract: SupplyContract): SellingConsequences {
  const fee = Math.floor(
    (contract.totalValueCredits * SimulatorEngine.MARKET_TRANSACTION_FEE_BPS) / 10000,
  );
  return {
    buyerEscrowCredits: contract.totalValueCredits,
    sellerCollateralCredits: contract.collateralSellerCredits,
    marketFeeCredits: fee,
    sellerNetOnFullDeliveryCredits: contract.totalValueCredits - fee,
    penaltyPerMissingUnitCredits: contract.penaltyPerMissingUnit,
    maximumDefaultIndemnityCredits: Math.min(
      contract.collateralSellerCredits,
      contract.totalQuantity * contract.penaltyPerMissingUnit,
    ),
  };
}

export class FactoryMatch {
  public readonly matchId: string;
  public readonly tickIntervalMs: number;
  public readonly engine: SimulatorEngine;
  /** Issue #55: drives NPC companies inside the authoritative tick loop. */
  private readonly npcController: NpcController;

  /** requestId -> acknowledged command and its payload fingerprint. */
  private readonly requestLedger = new Map<string, { fingerprint: string; commandId: string }>();
  /** commandId -> latest known command status. */
  private readonly commandRecords = new Map<string, CommandStatusView>();
  /** Number of engine execution results already folded into command records. */
  private historyCursor = 0;
  /** Last journal sequence durably committed; advanced only after SQL succeeds. */
  private creditJournalSequence = 0;

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
    this.matchId = boot?.metadata.matchId ?? options.matchId ?? createMatchId();
    this.engine = new SimulatorEngine(this.seed, this.matchId);
    this.engine.initializeStandardMatch();
    // Issue #55: NPC policies run inside the authoritative match tick loop.
    this.npcController = new NpcController({ seed: this.seed });
    this.tickIntervalMs = boot?.metadata.tickIntervalMs ?? requestedTickIntervalMs;

    const store = this.store;
    if (!boot || !store) return;
    this.sequenceFloor = boot.metadata.sequenceCounter;
    this.tickFloor = boot.metadata.currentTick;
    // The cursor is a floor, not a mirror: a restart must never re-fold results
    // the database already recorded (S8).
    this.historyCursor = Math.max(boot.metadata.historyCursor, boot.results.length);
    this.restoreBookkeeping(boot);
    this.restoreEngineState();
    const hadOpening = this.restoreCreditJournal(boot.adopted);
    if (!boot.adopted || !hadOpening) {
      // New worlds and their COMPLETE opening commit together. Legacy cutover
      // writes only new evidence: no core row or old balance is repaired.
      runAtomic(store.database, () => {
        if (!boot.adopted) this.persistEngineSnapshot();
        if (!hadOpening) store.repositories.creditJournal.createOpening(this.engine.getCreditLedger().opening);
      });
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

  /** Restore durable evidence or observe an explicitly unverified legacy cut. */
  private restoreCreditJournal(adopted: boolean): boolean {
    const store = this.store;
    if (!store) return false;
    const record = store.repositories.creditJournal.getOpening(this.matchId);
    const opening = record ? {
      matchId: record.matchId, observedAtTick: record.observedAtTick,
      coverage: record.coverage, balances: record.balances,
    } : createEngineCreditOpening(this.matchId, this.engine.getCurrentTick(),
      adopted ? 'CUTOVER' : 'COMPLETE', this.engine.getAllCompanies(), this.engine.getAllContracts());
    const movements = store.repositories.creditJournal.list(this.matchId)
      .map(({ recordedAtUtc: _at, ...movement }) => movement);
    this.engine.hydrate({ creditLedger: { opening, movements } });
    this.creditJournalSequence = movements.length;
    return record !== null;
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

  /**
   * Advance the authoritative simulation by one or more discrete ticks.
   *
   * Each tick is one unit of work on both sides (risk item 4): the engine
   * mutates in memory, then the whole tick is persisted atomically. If the
   * durable write refuses the tick, the engine is rewound to the checkpoint
   * taken just before it, so the failure leaves the match exactly where the
   * database already was and the caller can retry the same tick.
   *
   * The rollback is per tick, not per call: a multi-tick call whose later tick
   * fails keeps every earlier tick that already committed. The original error is
   * always rethrown unchanged, so a caller (the clock, HTTP, a test) sees the
   * same failure it would without rollback.
   */
  public advanceTicks(count = 1): void {
    for (let index = 0; index < count; index += 1) {
      const checkpoint = this.engine.createCheckpoint();
      try {
        // Issue #55: NPC policies evaluate before each authoritative tick and
        // enqueue their commands through the same queue; decisions are a pure
        // function of (match state, tick, seed), so replay, restart and
        // failed-tick recovery reproduce them exactly.
        const npcCommands = this.npcController.stepTick(this.engine);
        this.engine.processTick();
        // The NPC commands skipped the store-admission path, so their dedupe
        // keys are persisted with the tick that enqueued them.
        this.commitTickProgress(npcCommands);
      } catch (error) {
        // Undo only this tick; anything committed before it stays committed.
        this.engine.restoreCheckpoint(checkpoint);
        throw error;
      }
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
    if (!this.ownsLine(input.lineId)) {
      return { kind: 'line_not_owned' };
    }

    return this.admitPlayerCommand({
      requestId: input.requestId,
      // Unchanged from the first release: persisted ledger rows hold this exact
      // fingerprint, so a retry that spans an upgrade must still match.
      fingerprint: `${input.lineId}\n${input.recipeId}`,
      body: {
        type: 'SET_PRODUCTION_TARGET',
        lineId: input.lineId,
        recipeId: SUPPORTED_RECIPE_ID,
        targetBatches: 1,
      },
    });
  }

  /**
   * Admit one pause, resume or priority command for the server-selected
   * company (issue #57).
   *
   * These are ordinary queued commands, not a second dispatch path: they reuse
   * the `/v1/production` ledger, the same acknowledgement and the same engine
   * queue, and the server picks the tick. Nothing here mutates simulation state,
   * so a settled request never costs a request ID and an exact retry returns
   * the acknowledgement it already had. Whether a control is legal right now
   * (for example retargeting a line that still holds an active batch) stays the
   * engine's decision at execution time.
   */
  public requestLineControl(input: LineControlRequestInput): AdmissionDecision {
    if (!this.ownsLine(input.lineId)) {
      return { kind: 'line_not_owned' };
    }

    if (input.action === 'priority') {
      return this.admitPlayerCommand({
        requestId: input.requestId,
        fingerprint: `${input.lineId}\npriority\n${input.priority}`,
        body: { type: 'SET_LINE_PRIORITY', lineId: input.lineId, priority: input.priority },
      });
    }
    return this.admitPlayerCommand({
      requestId: input.requestId,
      fingerprint: `${input.lineId}\n${input.action}`,
      body: input.action === 'pause'
        ? { type: 'PAUSE_PRODUCTION_LINE', lineId: input.lineId }
        : { type: 'RESUME_PRODUCTION_LINE', lineId: input.lineId },
    });
  }

  /** True when the server-selected company owns the line. */
  private ownsLine(lineId: string): boolean {
    return this.getServerCompany().lines.some((line) => line.lineId === lineId);
  }

  /**
   * The single durable admission path a player write goes through.
   *
   * One admission is one ledger entry plus one queued command. Durably the
   * order is the opposite of the client's: the queue row, the permanent dedupe
   * key and the acknowledgement commit in one transaction, and only then does
   * the engine observe the command. `fingerprint` is the whole validated
   * payload, so an exact retry is idempotent while any other reuse of the same
   * request ID is refused without touching the original command.
   */
  private admitPlayerCommand(input: {
    readonly requestId: string;
    readonly fingerprint: string;
    readonly body: PlayerCommandBody;
  }): AdmissionDecision {
    const acknowledged = this.requestLedger.get(input.requestId);
    if (acknowledged) {
      if (acknowledged.fingerprint === input.fingerprint) {
        return { kind: 'queued', commandId: acknowledged.commandId };
      }
      return { kind: 'request_id_reused' };
    }

    if (this.requestLedger.size >= MAX_ACKNOWLEDGED_REQUESTS) {
      return { kind: 'command_limit' };
    }

    const commandId = `cmd_${randomBytes(12).toString('hex')}`;
    const command: EnqueueCommandInput = {
      ...input.body,
      commandId,
      companyId: SERVER_COMPANY_ID,
      scheduledTick: this.engine.getCurrentTick() + 1,
      idempotencyKey: `http:${this.matchId}:${input.requestId}`,
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
            fingerprint: input.fingerprint,
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

    this.requestLedger.set(input.requestId, { fingerprint: input.fingerprint, commandId });
    this.commandRecords.set(commandId, { commandId, status: 'queued' });
    return { kind: 'queued', commandId };
  }

  /** Admit an already authorized/validated MCP command before acknowledging it. */
  public submitMcpCommand(input: EnqueueCommandInput): boolean {
    const queue = this.engine.getCommandQueue();
    if (input.companyId !== SERVER_COMPANY_ID || queue.isIdempotencyKeyUsed(input.idempotencyKey)) {
      return false;
    }
    const command: EnqueueCommandInput = {
      ...input,
      commandId: `mcp_${randomBytes(12).toString('hex')}`,
      companyId: SERVER_COMPANY_ID,
      scheduledTick: this.engine.getCurrentTick() + 1,
    };
    if (this.store) {
      const checkpoint = {
        commands: queue.listPending(),
        processedIdempotencyKeys: queue.listProcessedIdempotencyKeys(),
        sequenceCounter: queue.getSequenceCounter(),
      };
      const nextSequence = this.currentSequenceNumber() + 1;
      try {
        this.store.commitCommand({
          metadata: this.snapshotMetadata({ sequenceCounter: nextSequence }),
          command: {
            commandId: command.commandId, matchId: this.matchId,
            companyId: command.companyId, sequenceNumber: nextSequence,
            scheduledTick: command.scheduledTick, idempotencyKey: command.idempotencyKey,
            commandType: command.type,
            payloadJson: JSON.stringify({ ...command, sequenceNumber: nextSequence }),
          },
          processed: { matchId: this.matchId, commandId: command.commandId, idempotencyKey: command.idempotencyKey },
          apply: () => this.engine.submitCommand(command),
        });
      } catch (error) {
        // Also undo an in-memory admission if the transaction's COMMIT failed.
        queue.restore(checkpoint);
        if (error instanceof CommandNotAccepted) return false;
        throw error;
      }
    } else if (!this.engine.submitCommand(command)) {
      return false;
    }
    this.commandRecords.set(command.commandId, { commandId: command.commandId, status: 'queued' });
    return true;
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
   * One transaction (risk item 4) now covers five things: the `matches`
   * counters, the new execution-history rows, the queue rows those results
   * clear, the permanent dedupe keys of the NPC commands this tick enqueued,
   * and the engine snapshot (companies, inventory, lines, contracts, S5). A
   * crash can therefore never leave the stored tick ahead of the company rows
   * that describe it, which is the window T3 documented.
   *
   * The NPC keys belong to this unit of work because NPC commands never pass
   * through the store-admission path that records every player key (issue #55).
   * Recording them here keeps the "dedupe guard is re-armed before the clock
   * starts" promise true for every queued command, and keeps the pairing
   * honest: if the tick is refused, the transaction drops the rows and the
   * engine checkpoint drops the in-memory keys together.
   *
   * Ordering and consistency: the durable write runs first and the in-memory
   * fold second, so memory never holds a status the database refused (see
   * `MatchStore`). The cursor stays monotonic (`Math.max`).
   */
  private commitTickProgress(npcCommands: readonly EnqueueCommandInput[] = []): void {
    const history = this.engine.getExecutionHistory();
    const folded = history.slice(this.historyCursor);
    const nextCursor = Math.max(this.historyCursor, history.length);
    const journal = this.engine.getCreditLedger();
    const movements = journal.movements.slice(this.creditJournalSequence);

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
          ...(movements.length ? { movements } : {}),
        });
        for (const command of npcCommands) {
          store.repositories.queue.markProcessed({
            matchId: this.matchId,
            idempotencyKey: command.idempotencyKey,
            commandId: command.commandId,
          });
        }
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
    this.creditJournalSequence = journal.movements.length;
  }

  /** The server-selected company, or an invariant failure. */
  public getServerCompany(): CompanyState {
    const company = this.engine.getCompany(SERVER_COMPANY_ID);
    if (!company) {
      throw new Error(`The server-selected company ${SERVER_COMPANY_ID} is missing from the match`);
    }
    return company;
  }

  /**
   * The public supply book (issue #58).
   *
   * Only offers anyone may accept right now are listed: `PENDING` offers whose
   * deadline has not passed. Entry order is the engine's contract order, so two
   * identical matches produce identical books. The projection is derived from
   * engine state on every request and mutates nothing.
   */
  public getMarketOffersPayload(): MarketOffersPayload {
    const tick = this.engine.getCurrentTick();
    const offers = this.engine
      .getAllContracts()
      .filter((contract) => isTradableOffer(contract, tick))
      .map((contract) => ({
        contractId: contract.contractId,
        sellerCompanyId: contract.sellerCompanyId,
        // The engine uses '' for "any buyer"; the wire says so explicitly.
        buyerCompanyId: contract.buyerCompanyId === '' ? null : contract.buyerCompanyId,
        itemId: contract.itemId,
        quantity: contract.totalQuantity,
        unitPriceCredits: contract.unitPriceCredits,
        totalValueCredits: contract.totalValueCredits,
        createdAtTick: contract.createdAtTick,
        deadlineTick: contract.deadlineTick,
      }));

    return { tick, offers };
  }

  /**
   * The server-selected company's own contracts (issue #58).
   *
   * Terms, delivery progress, status and settlement tick are projected verbatim
   * from engine state; the route adds nothing and decides nothing. Foreign
   * drafts and foreign contracts never appear.
   */
  public getContractsPayload(): ContractsPayload {
    const company = this.getServerCompany();
    const tick = this.engine.getCurrentTick();
    const contracts = this.engine
      .getAllContracts()
      .filter((contract) => isOwnContract(contract, company.companyId))
      .map((contract) => ({
        contractId: contract.contractId,
        sellerCompanyId: contract.sellerCompanyId,
        buyerCompanyId: contract.buyerCompanyId,
        itemId: contract.itemId,
        totalQuantity: contract.totalQuantity,
        deliveredQuantity: contract.deliveredQuantity,
        unitPriceCredits: contract.unitPriceCredits,
        totalValueCredits: contract.totalValueCredits,
        collateralSellerCredits: contract.collateralSellerCredits,
        createdAtTick: contract.createdAtTick,
        deadlineTick: contract.deadlineTick,
        status: contract.status,
        settledAtTick: contract.settledAtTick ?? null,
      }));

    return { tick, companyId: company.companyId, contracts };
  }

  /**
   * The seller loop as the owner session sees it (issue #58, milestone B).
   *
   * Own contracts are projected with the engine figures a human confirmation
   * must show, and the acting company's recent command outcomes are reported by
   * the caller's own idempotency key so a queued 202 can be followed to its
   * final executed or rejected result. No foreign contract, token or digest is
   * ever included and no state changes here.
   */
  public getOwnerSellingPayload(): OwnerSellingPayload {
    const company = this.getServerCompany();
    return {
      tick: this.engine.getCurrentTick(),
      companyId: company.companyId,
      availableCredits: company.credits,
      marketFeeBps: SimulatorEngine.MARKET_TRANSACTION_FEE_BPS,
      contracts: this.engine
        .getAllContracts()
        .filter((contract) => isOwnContract(contract, company.companyId))
        .map((contract) => ({
          contractId: contract.contractId,
          sellerCompanyId: contract.sellerCompanyId,
          buyerCompanyId: contract.buyerCompanyId === '' ? null : contract.buyerCompanyId,
          itemId: contract.itemId,
          totalQuantity: contract.totalQuantity,
          deliveredQuantity: contract.deliveredQuantity,
          unitPriceCredits: contract.unitPriceCredits,
          totalValueCredits: contract.totalValueCredits,
          collateralSellerCredits: contract.collateralSellerCredits,
          createdAtTick: contract.createdAtTick,
          deadlineTick: contract.deadlineTick,
          status: contract.status,
          settledAtTick: contract.settledAtTick ?? null,
          consequences: sellingConsequences(contract),
        })),
      recentCommands: this.engine
        .getCompanyExecutionHistory(company.companyId, SELLING_HISTORY_LIMIT)
        .map((result) => ({
          idempotencyKey: result.idempotencyKey,
          status: result.success ? 'executed' as const : 'rejected' as const,
          executedAtTick: result.executedAtTick,
          errorCode: result.errorCode ?? null,
        })),
    };
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
