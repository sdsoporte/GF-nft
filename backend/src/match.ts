/**
 * Authoritative match wrapper.
 *
 * The match owns exactly one simulation engine instance, the server-selected
 * company, the protocol projections and (in a later stage) the per-match
 * command acknowledgement ledger. Clients never receive engine objects; every
 * response is a detached, JSON-safe projection.
 */

import { randomBytes } from 'node:crypto';

import { getRecipe, getRecipeProfile } from '../../src/domain/recipeCatalog.ts';
import type { CompanyState, IndustrialClass, RecipeId } from '../../src/domain/types.ts';
import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';

export const PROTOCOL_VERSION = 1;
export const SERVER_COMPANY_ID = 'comp_metal_01';
export const SUPPORTED_RECIPE_ID = 'R1' as const;
export const DEFAULT_TICK_INTERVAL_MS = 1000;
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

  constructor(options: FactoryMatchOptions = {}) {
    this.engine = new SimulatorEngine(options.seed ?? 42107);
    this.engine.initializeStandardMatch();
    this.matchId = options.matchId ?? createMatchId();
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }

  /** Advance the authoritative simulation by one or more discrete ticks. */
  public advanceTicks(count = 1): void {
    for (let index = 0; index < count; index += 1) {
      this.engine.processTick();
      this.reconcileCommandRecords();
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
    const accepted = this.engine.submitCommand({
      commandId,
      companyId: SERVER_COMPANY_ID,
      scheduledTick: this.engine.getCurrentTick() + 1,
      idempotencyKey: `http:${this.matchId}:${input.requestId}`,
      type: 'SET_PRODUCTION_TARGET',
      lineId: input.lineId,
      recipeId: SUPPORTED_RECIPE_ID,
      targetBatches: 1,
    });
    if (!accepted) {
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

  private reconcileCommandRecords(): void {
    const history = this.engine.getExecutionHistory();
    while (this.historyCursor < history.length) {
      const result = history[this.historyCursor];
      this.historyCursor += 1;
      const record = this.commandRecords.get(result.commandId);
      if (!record) continue;
      record.status = result.success ? 'executed' : 'rejected';
      record.executedAtTick = result.executedAtTick;
      record.errorCode = result.success ? undefined : result.errorCode;
    }
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
