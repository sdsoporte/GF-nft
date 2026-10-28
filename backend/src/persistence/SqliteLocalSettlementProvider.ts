/**
 * GigaForge v4.1 - SQLite Local Settlement Provider & Reservation Service
 * Reference: WEB3_DOMAIN_MODEL.md
 *
 * S10 (issue #8): the name now describes an authentic SQLite implementation.
 * Every lot, reservation, escrow, stock movement and balance change this class
 * performs is a row written through `src/persistence/repos` on the handle passed
 * to the constructor, inside one `runAtomic` unit of work. There is no `Map` of
 * ledger state behind the name: the constructor *requires* a `Database` from
 * `openDatabase()` + `migrate()`, and a fresh provider over the same file sees
 * exactly the same lots, escrows and balances (see
 * `tests/persistence/provider-restart.test.ts`).
 *
 * Implements:
 * - InventoryReservationService: atomic packaging of physical materials into CommodityLots
 * - SettlementProvider: atomic trade escrow with 20% collateral, 2% market fee burn, and release
 * - Invariant 1: Material Conservation (no double counting) — the available -> reserved
 *   movement is the guarded `ReservationRepository.reserve` UPDATE, not an object edit
 * - Invariant 2: Ownership vs Usage separation
 * - EIP-712 anti-replay authorization generation
 * - Circuit Breaker Reconciliation: integrity check preventing ledger discrepancy
 *
 * Storage decisions (T5a), deliberately documented because they are design
 * choices a reader cannot infer from the code alone:
 *
 * 1. **The database is the authority, not the caller's objects.** `createEscrow`
 *    validates the *persisted* lot row, and every reader returns rows. A stale
 *    `CommodityLot` argument can therefore not overwrite newer stored state. The
 *    argument's `status` is still updated in place for compatibility, because it
 *    is a mutable domain object and the previous implementation did the same.
 * 2. **Ids come from a durable sequence** (`settlement_counters`, migration 3).
 *    The former in-process counters would restart at 1 and collide with existing
 *    rows; the sequence survives a restart and the schema's PRIMARY KEY / UNIQUE
 *    indexes turn any duplicated id into a loud rejection instead of a silent
 *    overwrite (`LotRepository.create` / `EscrowRepository.create`).
 * 3. **EIP-712 nonces persist** (`account_nonces`, migration 3). An anti-replay
 *    nonce kept in memory would be reissued after a restart, which reopens
 *    exactly the replay window the nonce exists to close.
 * 4. **The circuit-breaker latch stays process-local BY DESIGN.** It is an
 *    operator safety switch, not ledger data: the evidence that trips it
 *    (reserved balances vs active lots) is entirely in SQLite, so a restarted
 *    process starts unlatched and the first `reconcileLedgerState()` trips it
 *    again on the same rows with the same reason. Persisting the latch would let
 *    a stale flag block a healthy database after an operator already fixed it.
 * 5. **Atomicity is inherited, not re-implemented.** Each public operation opens
 *    one `runAtomic` unit; the repository methods inside it join as savepoints, so
 *    a failure anywhere unwinds lot state, reservation status, inventory and
 *    credits together (S7). The former implementation mutated objects and could
 *    not roll back.
 *
 * Wiring note: this class no longer reads or mutates `SimulatorEngine`. A match
 * that uses it must treat the database as the source of truth and hydrate the
 * engine from the repository rows (the T4 `SimulatorEngine.hydrate` surface),
 * instead of expecting the provider to keep two ledgers in step.
 */

import type { Database } from 'bun:sqlite';

import { SimulatorEngine } from '../engine/SimulatorEngine.ts';
import { assertSafeInteger } from '../domain/recipeCatalog.ts';
import { ItemId } from '../domain/types.ts';
import {
  calculateLotStateHash,
  CommodityLot,
  Eip712LotVoucher,
  InventoryReservationService,
  LotStatus,
  SettlementProvider,
  TradeEscrowRecord,
  validateLotTransition,
} from '../domain/web3DomainModel.ts';
import { createRepositories, type CompanyRecord, type Repositories } from './repos/index.ts';
import { runAtomic } from './transaction.ts';

/** Lot states that still hold stock in `inventory.reserved`. */
const ACTIVE_LOT_STATUSES: readonly LotStatus[] = [
  'RESERVED_OFF_CHAIN',
  'TOKENIZED_RECEIPT',
  'IN_ESCROW',
  'SETTLED_PENDING_CLAIM',
];

export class SqliteLocalSettlementProvider
  implements InventoryReservationService, SettlementProvider
{
  private readonly database: Database;
  private readonly repos: Repositories;

  /**
   * Operator safety latch (see decision 4 in the file header): not persisted, and
   * re-derived by `reconcileLedgerState()` from the rows after a restart.
   */
  private circuitBreakerTripped = false;
  private circuitBreakerReason: string | null = null;

  /**
   * `database` must be opened with `openDatabase()` and migrated with `migrate()`;
   * anything else is a programming error, so it fails here instead of behaving
   * like an implicit in-memory store.
   */
  constructor(database: Database) {
    if (!database || typeof (database as { query?: unknown }).query !== 'function') {
      throw new Error(
        'SqliteLocalSettlementProvider requires a Database handle from openDatabase() and migrate()',
      );
    }
    this.database = database;
    this.repos = createRepositories(database);
  }

  public isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  public getCircuitBreakerReason(): string | null {
    return this.circuitBreakerReason;
  }

  public getAllLots(): CommodityLot[] {
    return this.repos.lots.list();
  }

  public getLot(lotId: string): CommodityLot | undefined {
    return this.repos.lots.load(lotId) ?? undefined;
  }

  public getAllEscrows(): TradeEscrowRecord[] {
    return this.repos.escrows.list();
  }

  public getEscrow(escrowId: string): TradeEscrowRecord | undefined {
    return this.repos.escrows.load(escrowId) ?? undefined;
  }

  // --- INVENTORY RESERVATION SERVICE (INVARIANT 1) ---

  /**
   * Lock factory materials into a commercial CommodityLot.
   *
   * One unit of work: allocate the ids, move `available -> reserved` and insert
   * the reservation row (guarded by the repository), then insert the lot. A
   * failure at any step leaves the stock untouched.
   */
  public async lockMaterialsForLot(
    companyId: string,
    itemId: ItemId,
    quantity: number,
    currentTick: number
  ): Promise<CommodityLot> {
    this.assertNotHalted('New reservations');

    assertSafeInteger(quantity, 'quantity');
    if (quantity <= 0) {
      throw new Error('Quantity must be a positive safe integer');
    }

    const company = this.repos.companies.load(companyId);
    if (!company) {
      throw new Error(`Company "${companyId}" not found`);
    }

    const stock = company.inventory[itemId];
    if (stock.available < quantity) {
      throw new Error(
        `Insufficient available stock of ${itemId}. Requested: ${quantity}, Available: ${stock.available}`
      );
    }

    return runAtomic(this.database, () => {
      const lotId = `lot_${currentTick}_${this.repos.settlementCounters.next('lot')}`;
      const reservationId = `res_${currentTick}_${this.repos.settlementCounters.next(
        'reservation'
      )}`;

      this.repos.reservations.reserve({
        reservationId,
        lotId,
        companyId,
        itemId,
        quantity,
        createdAtTick: currentTick,
      });

      return this.repos.lots.create({
        lotId,
        originCompanyId: companyId,
        currentHolderCompanyId: companyId,
        itemId,
        quantity,
        reservationId,
        status: 'RESERVED_OFF_CHAIN',
        stateHash: calculateLotStateHash(lotId, itemId, quantity, companyId),
        createdAtTick: currentTick,
      });
    });
  }

  /**
   * Unpack settled lot directly into the buyer's factory inventory
   */
  public async unpackLotToInventory(
    lotId: string,
    receiverCompanyId: string,
    currentTick: number
  ): Promise<void> {
    this.assertNotHalted('Unpacking');
    runAtomic(this.database, () => this.unpackLot(lotId, receiverCompanyId, currentTick));
  }

  /**
   * Cancel reservation and restore materials to available inventory
   */
  public async revertReservation(lotId: string, currentTick: number): Promise<void> {
    runAtomic(this.database, () => {
      const lot = this.repos.lots.load(lotId);
      if (!lot) {
        throw new Error(`Lot "${lotId}" not found`);
      }

      validateLotTransition(lot.status, 'CANCELLED_RESTORED');

      if (!this.repos.companies.exists(lot.originCompanyId)) {
        throw new Error(`Origin company "${lot.originCompanyId}" not found`);
      }

      // `REVERTED` credits the stock back to the origin company; the repository
      // performs the guarded `reserved -> available` movement.
      this.repos.reservations.release({
        reservationId: lot.reservationId,
        status: 'REVERTED',
        atTick: currentTick,
      });
      this.repos.lots.setStatus(lotId, 'CANCELLED_RESTORED', currentTick);
    });
  }

  // --- TOKENIZATION VOUCHER GENERATION (FASE 3 READY) ---

  /**
   * Emit EIP-712 anti-replay authorization voucher.
   *
   * The nonce is taken from `account_nonces` in the same transaction that moves
   * the lot to `TOKENIZED_RECEIPT`, so a crash can neither burn a nonce without
   * tokenizing nor tokenize without burning one.
   */
  public generateEip712Voucher(
    lotId: string,
    chainId: number = 8453, // Base Mainnet / Sepolia
    verifyingContract: string = '0xGigaForgeTradeEscrow1155'
  ): Eip712LotVoucher {
    const lot = this.repos.lots.load(lotId);
    if (!lot) {
      throw new Error(`Lot "${lotId}" not found`);
    }

    validateLotTransition(lot.status, 'TOKENIZED_RECEIPT');

    return runAtomic(this.database, () => {
      const nonce = this.repos.settlementCounters.nextAccountNonce(lot.originCompanyId);
      this.repos.lots.setStatus(lotId, 'TOKENIZED_RECEIPT', lot.settledAtTick ?? null);

      const expirationTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity

      // Simulated ECDSA signature over EIP-712 struct
      const signature = `0xsim_sig_${lot.stateHash}_nonce_${nonce}`;

      return {
        chainId,
        verifyingContract,
        lotId,
        originCompanyId: lot.originCompanyId,
        itemId: lot.itemId,
        quantity: lot.quantity,
        nonce,
        expirationTimestamp,
        signature,
      };
    });
  }

  // --- SETTLEMENT PROVIDER (ESCROW & SETTLEMENT) ---

  /**
   * Create trade escrow record locking buyer payment and 20% seller collateral.
   *
   * Both credit debits, the escrow row and the lot's `IN_ESCROW` status are one
   * unit of work: an under-funded counterparty or a rejected insert leaves every
   * balance untouched (S7).
   */
  public async createEscrow(
    lot: CommodityLot,
    buyerCompanyId: string,
    price: number,
    deadlineTick: number
  ): Promise<TradeEscrowRecord> {
    this.assertNotHalted('Escrow creation');

    assertSafeInteger(price, 'price');
    assertSafeInteger(deadlineTick, 'deadlineTick');
    if (price <= 0) {
      throw new Error('Agreed price must be a positive integer');
    }

    return runAtomic(this.database, () => {
      // The persisted row is the authority (decision 1): a stale argument cannot
      // move a lot that is already escrowed or settled.
      const persisted = this.repos.lots.load(lot.lotId);
      if (!persisted) {
        throw new Error(`Lot "${lot.lotId}" not found`);
      }
      validateLotTransition(persisted.status, 'IN_ESCROW');

      const seller = this.repos.companies.load(persisted.originCompanyId);
      const buyer = this.repos.companies.load(buyerCompanyId);
      if (!seller || !buyer) {
        throw new Error('Seller or Buyer company not found');
      }

      // 20% seller collateral
      const sellerCollateral = Math.floor((price * 20) / 100);

      if (seller.credits < sellerCollateral) {
        throw new Error(`Seller requires ${sellerCollateral} Credits collateral`);
      }
      if (buyer.credits < price) {
        throw new Error(`Buyer requires ${price} Credits for escrow`);
      }

      // Lock funds
      this.saveCompanyBalance(seller, seller.credits - sellerCollateral);
      this.saveCompanyBalance(buyer, buyer.credits - price);

      const escrowId = `esc_${persisted.createdAtTick}_${this.repos.settlementCounters.next(
        'escrow'
      )}`;
      const record: TradeEscrowRecord = {
        escrowId,
        lotId: persisted.lotId,
        sellerCompanyId: seller.companyId,
        buyerCompanyId: buyer.companyId,
        agreedPriceAmount: price,
        currencyType: 'INTERNAL_CREDITS',
        sellerCollateralAmount: sellerCollateral,
        deadlineTick,
        settlementState: 'LOCKED',
      };
      this.repos.escrows.create(record);
      this.repos.lots.setStatus(persisted.lotId, 'IN_ESCROW', persisted.settledAtTick ?? null);

      // Compatibility with the previous mutable-object contract.
      lot.status = 'IN_ESCROW';

      return record;
    });
  }

  /**
   * Verify delivery, execute payment minus 2% burn, return collateral, and unpack goods.
   *
   * Lot status, reservation status, both parties' inventory, both parties'
   * credits/reputation and the escrow row commit together; the induced-failure
   * test in `tests/persistence/provider.test.ts` pins the complete rollback.
   */
  public async verifyAndSettleDelivery(
    escrowId: string,
    currentTick: number
  ): Promise<{ settled: boolean; txReference: string }> {
    this.assertNotHalted('Settlement');

    return runAtomic(this.database, () => {
      const escrow = this.repos.escrows.load(escrowId);
      if (!escrow) {
        throw new Error(`Escrow "${escrowId}" not found`);
      }

      if (escrow.settlementState !== 'LOCKED') {
        throw new Error(`Escrow state is "${escrow.settlementState}", expected "LOCKED"`);
      }

      const lot = this.repos.lots.load(escrow.lotId);
      if (!lot) {
        throw new Error(`Associated lot "${escrow.lotId}" not found`);
      }

      const seller = this.repos.companies.load(escrow.sellerCompanyId);
      const buyer = this.repos.companies.load(escrow.buyerCompanyId);
      if (!seller || !buyer) {
        throw new Error('Counterparties not found');
      }

      // Transition lot to SETTLED_PENDING_CLAIM
      validateLotTransition(lot.status, 'SETTLED_PENDING_CLAIM');
      this.repos.lots.setStatus(lot.lotId, 'SETTLED_PENDING_CLAIM', lot.settledAtTick ?? null);

      // Unpack immediately to buyer inventory
      this.unpackLot(lot.lotId, buyer.companyId, currentTick);

      // Release 20% collateral back to seller and pay the price minus the burn.
      const marketFee = Math.floor((escrow.agreedPriceAmount * 2) / 100);
      const netSellerPayment = escrow.agreedPriceAmount - marketFee;
      this.saveCompanyBalance(
        seller,
        seller.credits + escrow.sellerCollateralAmount + netSellerPayment,
        seller.reputation + 5
      );

      // Reputation bonus for clean fulfillment (buyer pays nothing on top).
      this.saveCompanyBalance(buyer, buyer.credits, buyer.reputation + 5);

      this.repos.escrows.setState(escrow.escrowId, 'RELEASED_TO_BUYER', currentTick);

      return { settled: true, txReference: `gf_tx_${currentTick}_${escrow.escrowId}` };
    });
  }

  // --- AUTOMATED CIRCUIT BREAKER & RECONCILIATION ---

  /**
   * Reconcile all company reserved stocks against sum of active CommodityLots.
   * If discrepancy != 0, trips the circuit breaker and freezes all lot/escrow operations.
   *
   * Both sides of the comparison are SQLite rows (`inventories.reserved_qty` and
   * the active `commodity_lots` rows), so the check is meaningful after a restart
   * even though the latch itself is process-local.
   */
  public async reconcileLedgerState(): Promise<{
    discrepanciesFound: number;
    haltedLots: string[];
    isCircuitBreakerTripped: boolean;
  }> {
    let discrepanciesFound = 0;
    const haltedLots: string[] = [];
    const lots = this.repos.lots.list();

    // Calculate sum of active lots per company and item
    const expectedReservedMap = new Map<string, number>();
    for (const lot of lots) {
      if (!ACTIVE_LOT_STATUSES.includes(lot.status)) continue;
      const key = `${lot.originCompanyId}:${lot.itemId}`;
      expectedReservedMap.set(key, (expectedReservedMap.get(key) ?? 0) + lot.quantity);
    }

    // Check against the persisted inventories
    for (const company of this.repos.companies.loadAll()) {
      for (const [itemId, stock] of Object.entries(company.inventory)) {
        const key = `${company.companyId}:${itemId}`;
        const activeLotsSum = expectedReservedMap.get(key) ?? 0;

        if (stock.reserved !== activeLotsSum) {
          discrepanciesFound += 1;
          this.circuitBreakerTripped = true;
          this.circuitBreakerReason = `Discrepancy detected for company ${company.companyId} item ${itemId}: inventory.reserved (${stock.reserved}) !== activeLotsSum (${activeLotsSum})`;

          // Collect affected lots
          for (const lot of lots) {
            if (lot.originCompanyId === company.companyId && lot.itemId === itemId) {
              haltedLots.push(lot.lotId);
            }
          }
        }
      }
    }

    return {
      discrepanciesFound,
      haltedLots,
      isCircuitBreakerTripped: this.circuitBreakerTripped,
    };
  }

  /**
   * Manual reset for Circuit Breaker after operator inspection
   */
  public resetCircuitBreaker(): void {
    this.circuitBreakerTripped = false;
    this.circuitBreakerReason = null;
  }

  // --- internals -----------------------------------------------------------

  private assertNotHalted(action: string): void {
    if (this.circuitBreakerTripped) {
      throw new Error(`[Circuit Breaker Active] ${action} halted: ${this.circuitBreakerReason}`);
    }
  }

  /**
   * Deliver a lot to `receiverCompanyId`: close the reservation as `UNPACKED`
   * (reserved at the origin -> available for the receiver) and burn the lot.
   * Synchronous so callers can compose it inside one `runAtomic` unit.
   */
  private unpackLot(lotId: string, receiverCompanyId: string, currentTick: number): void {
    const lot = this.repos.lots.load(lotId);
    if (!lot) {
      throw new Error(`Lot "${lotId}" not found`);
    }

    validateLotTransition(lot.status, 'CONSUMED_UNPACKED');

    const originCompany = this.repos.companies.load(lot.originCompanyId);
    const receiverCompany = this.repos.companies.load(receiverCompanyId);
    if (!originCompany || !receiverCompany) {
      throw new Error('Participating companies not found');
    }

    this.repos.reservations.release({
      reservationId: lot.reservationId,
      status: 'UNPACKED',
      recipientCompanyId: receiverCompanyId,
      atTick: currentTick,
    });
    this.repos.lots.setStatus(lotId, 'CONSUMED_UNPACKED', currentTick);
  }

  /**
   * Persist credit/reputation changes on the company row. The aggregate
   * inventory/lines rows are untouched: this operation only moves money and
   * reputation, and `companies.save` writes exactly the company columns.
   */
  private saveCompanyBalance(
    company: CompanyRecord,
    credits: number,
    reputation: number = company.reputation
  ): void {
    this.repos.companies.save({
      companyId: company.companyId,
      name: company.name,
      industrialClass: company.industrialClass,
      isNPC: company.isNPC,
      credits,
      energy: company.energy,
      maxEnergyStorage: company.maxEnergyStorage,
      energyGenerationPerTick: company.energyGenerationPerTick,
      installedTurbinesR7: company.installedTurbinesR7,
      contributedMegamachinePartsR8: company.contributedMegamachinePartsR8,
      reputation,
      maintenancePaidTicks: company.maintenancePaidTicks,
      createdAtUtc: company.createdAtUtc,
    });
  }
}

/**
 * Retained as a type-only reference for callers that still hand the provider an
 * engine: the class no longer uses it (see the wiring note in the file header),
 * but keeping the import documented would be misleading, so it is exported here
 * as the parameter type of the legacy factory below.
 */
export type LegacyEngineDependency = SimulatorEngine;
