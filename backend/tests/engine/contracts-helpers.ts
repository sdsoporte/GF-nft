/**
 * Shared fixtures for the supply-contract lifecycle suites (T3).
 *
 * Every fixture builds its own `SimulatorEngine` with the fixed seed 42107, so
 * no test shares state with another and no assertion depends on wall-clock
 * time or unseeded randomness.
 *
 * Contracts are driven exclusively through public engine APIs: `submitCommand`,
 * `processTick`, `getCompany`, `getContract`, `getAllContracts` and
 * `getExecutionHistory`.
 */

import assert from 'node:assert/strict';

import { SimulatorEngine } from '../../src/engine/SimulatorEngine.ts';
import type {
  CommandExecutionResult,
  CompanyState,
  EnqueueCommandInput,
  ItemId,
  SupplyContract,
} from '../../src/domain/types.ts';

export const SEED = 42107;

/** Class A seller: starts with 200 RAW_ORE and 10,000 CREDITS. */
export const SELLER = 'comp_metal_01';
/** First Class B company, used as the default buyer. */
export const BUYER = 'comp_manuf_01';
/** Second Class A company, used as a third party in two-company scenarios. */
export const OUTSIDER_A = 'comp_metal_02';
/** Second Class B company, used as a third party in two-company scenarios. */
export const OUTSIDER_B = 'comp_manuf_02';

export function createEngine(): SimulatorEngine {
  const engine = new SimulatorEngine(SEED);
  engine.initializeStandardMatch();
  return engine;
}

export function companyOf(engine: SimulatorEngine, companyId: string): CompanyState {
  const company = engine.getCompany(companyId);
  assert.ok(company, `company ${companyId} must exist`);
  return company;
}

export function contractOf(engine: SimulatorEngine, contractId: string): SupplyContract {
  const contract = engine.getContract(contractId);
  assert.ok(contract, `contract ${contractId} must exist`);
  return contract;
}

/** Overwrite available stock so a scenario never depends on production drift. */
export function setStock(
  engine: SimulatorEngine,
  companyId: string,
  itemId: ItemId,
  available: number,
): void {
  companyOf(engine, companyId).inventory[itemId].available = available;
}

export function executionResult(
  engine: SimulatorEngine,
  commandId: string,
): CommandExecutionResult {
  const result = engine.getExecutionHistory().find((entry) => entry.commandId === commandId);
  assert.ok(result, `command ${commandId} must have executed`);
  return result;
}

export function expectExecuted(
  engine: SimulatorEngine,
  commandId: string,
): CommandExecutionResult {
  const result = executionResult(engine, commandId);
  assert.equal(result.success, true, `command ${commandId} expected success: ${result.errorCode}`);
  return result;
}

export function expectRejected(
  engine: SimulatorEngine,
  commandId: string,
  errorCode: string,
): CommandExecutionResult {
  const result = executionResult(engine, commandId);
  assert.equal(result.success, false, `command ${commandId} expected rejection ${errorCode}`);
  assert.equal(result.errorCode, errorCode);
  return result;
}

export interface CreateOfferParams {
  readonly itemId: ItemId;
  readonly quantity: number;
  readonly unitPriceCredits: number;
  readonly deadlineTicks: number;
  readonly targetBuyerId?: string;
}

/**
 * Thin driver that schedules one command per following tick and exposes the
 * `commandId` so a test can inspect the resulting execution record.
 */
export class ContractDriver {
  public readonly engine: SimulatorEngine;
  private sequence = 0;

  constructor(engine: SimulatorEngine = createEngine()) {
    this.engine = engine;
  }

  public get tick(): number {
    return this.engine.getCurrentTick();
  }

  /** Advance the simulation by `ticks` discrete ticks. */
  public run(ticks: number): void {
    for (let index = 0; index < ticks; index += 1) {
      this.engine.processTick();
    }
  }

  public createOffer(companyId: string, params: CreateOfferParams): string {
    const commandId = this.nextId('create_offer');
    this.enqueue({
      commandId,
      companyId,
      scheduledTick: this.tick + 1,
      idempotencyKey: `idem_${commandId}`,
      type: 'CREATE_SUPPLY_OFFER',
      itemId: params.itemId,
      quantity: params.quantity,
      unitPriceCredits: params.unitPriceCredits,
      deadlineTicks: params.deadlineTicks,
      ...(params.targetBuyerId === undefined ? {} : { targetBuyerId: params.targetBuyerId }),
    });
    return commandId;
  }

  public acceptOffer(companyId: string, contractId: string): string {
    const commandId = this.nextId('accept_offer');
    this.enqueue({
      commandId,
      companyId,
      scheduledTick: this.tick + 1,
      idempotencyKey: `idem_${commandId}`,
      type: 'ACCEPT_SUPPLY_OFFER',
      contractId,
    });
    return commandId;
  }

  public ship(companyId: string, contractId: string, quantityToShip: number): string {
    const commandId = this.nextId('ship');
    this.enqueue({
      commandId,
      companyId,
      scheduledTick: this.tick + 1,
      idempotencyKey: `idem_${commandId}`,
      type: 'SCHEDULE_INTERNAL_TRANSPORT',
      contractId,
      quantityToShip,
    });
    return commandId;
  }

  /** Cancel a pending offer (only its seller may do so). */
  public cancelOffer(companyId: string, contractId: string): string {
    const commandId = this.nextId('cancel_offer');
    this.enqueue({
      commandId,
      companyId,
      scheduledTick: this.tick + 1,
      idempotencyKey: `idem_${commandId}`,
      type: 'CANCEL_PENDING_OFFER',
      contractId,
    });
    return commandId;
  }

  private nextId(tag: string): string {
    this.sequence += 1;
    return `cmd_${tag}_${this.sequence}`;
  }

  private enqueue(command: EnqueueCommandInput): void {
    const accepted = this.engine.submitCommand(command);
    assert.ok(accepted, `command ${command.commandId} must enqueue`);
  }
}

export interface AcceptedContractFixture {
  readonly driver: ContractDriver;
  readonly engine: SimulatorEngine;
  readonly contractId: string;
}

export interface AcceptedContractOptions {
  readonly quantity: number;
  readonly unitPriceCredits: number;
  /** Absolute deadline tick; must be in the future when the offer executes. */
  readonly deadlineTicks: number;
  readonly itemId?: ItemId;
  readonly sellerStock?: number;
  readonly buyerCompanyId?: string;
}

/**
 * Create an offer from {@link SELLER} and accept it as {@link BUYER} (or the
 * supplied buyer). The offer executes on tick 1 and the acceptance on tick 2.
 */
export function createAcceptedContract(options: AcceptedContractOptions): AcceptedContractFixture {
  const engine = createEngine();
  const driver = new ContractDriver(engine);
  const itemId = options.itemId ?? 'STEEL_PLATE';

  if (options.sellerStock !== undefined) {
    setStock(engine, SELLER, itemId, options.sellerStock);
  }

  driver.createOffer(SELLER, {
    itemId,
    quantity: options.quantity,
    unitPriceCredits: options.unitPriceCredits,
    deadlineTicks: options.deadlineTicks,
  });
  driver.run(1);

  const created = engine.getAllContracts().at(-1);
  assert.ok(created, 'offer creation must produce a contract');

  driver.acceptOffer(options.buyerCompanyId ?? BUYER, created.contractId);
  driver.run(1);

  return { driver, engine, contractId: created.contractId };
}
