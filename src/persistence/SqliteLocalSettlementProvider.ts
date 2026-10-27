/**
 * GigaForge v4.1 - SQLite Local Settlement Provider & Reservation Service
 * Reference: WEB3_DOMAIN_MODEL.md
 *
 * Implements:
 * - InventoryReservationService: atomic packaging of physical materials into CommodityLots
 * - SettlementProvider: atomic trade escrow with 20% collateral, 2% market fee burn, and release
 * - Invariant 1: Material Conservation (no double counting)
 * - Invariant 2: Ownership vs Usage separation
 * - EIP-712 anti-replay authorization generation
 * - Circuit Breaker Reconciliation: automated integrity check preventing ledger discrepancy
 */

import { SimulatorEngine } from '../engine/SimulatorEngine.ts';
import { assertSafeInteger } from '../domain/recipeCatalog.ts';
import { ItemId } from '../domain/types.ts';
import {
  calculateLotStateHash,
  CommodityLot,
  Eip712LotVoucher,
  InventoryReservationService,
  SettlementProvider,
  TradeEscrowRecord,
  validateLotTransition,
} from '../domain/web3DomainModel.ts';

export class SqliteLocalSettlementProvider
  implements InventoryReservationService, SettlementProvider
{
  private lots: Map<string, CommodityLot> = new Map();
  private escrows: Map<string, TradeEscrowRecord> = new Map();
  private accountNonces: Map<string, number> = new Map();

  private lotCounter = 0;
  private escrowCounter = 0;
  private reservationCounter = 0;

  private circuitBreakerTripped = false;
  private circuitBreakerReason: string | null = null;

  constructor(private readonly engine: SimulatorEngine) {}

  public isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  public getCircuitBreakerReason(): string | null {
    return this.circuitBreakerReason;
  }

  public getAllLots(): CommodityLot[] {
    return Array.from(this.lots.values());
  }

  public getLot(lotId: string): CommodityLot | undefined {
    return this.lots.get(lotId);
  }

  public getAllEscrows(): TradeEscrowRecord[] {
    return Array.from(this.escrows.values());
  }

  public getEscrow(escrowId: string): TradeEscrowRecord | undefined {
    return this.escrows.get(escrowId);
  }

  // --- INVENTORY RESERVATION SERVICE (INVARIANT 1) ---

  /**
   * Lock factory materials into a commercial CommodityLot
   */
  public async lockMaterialsForLot(
    companyId: string,
    itemId: ItemId,
    quantity: number,
    currentTick: number
  ): Promise<CommodityLot> {
    if (this.circuitBreakerTripped) {
      throw new Error(`[Circuit Breaker Active] New reservations halted: ${this.circuitBreakerReason}`);
    }

    assertSafeInteger(quantity, 'quantity');
    if (quantity <= 0) {
      throw new Error('Quantity must be a positive safe integer');
    }

    const company = this.engine.getCompany(companyId);
    if (!company) {
      throw new Error(`Company "${companyId}" not found`);
    }

    const stock = company.inventory[itemId];
    if (stock.available < quantity) {
      throw new Error(
        `Insufficient available stock of ${itemId}. Requested: ${quantity}, Available: ${stock.available}`
      );
    }

    // Invariant 1: Move from available to reserved
    stock.available -= quantity;
    stock.reserved += quantity;

    assertSafeInteger(stock.available, 'stock.available');
    assertSafeInteger(stock.reserved, 'stock.reserved');

    const lotId = `lot_${currentTick}_${++this.lotCounter}`;
    const reservationId = `res_${currentTick}_${++this.reservationCounter}`;
    const stateHash = calculateLotStateHash(lotId, itemId, quantity, companyId);

    const newLot: CommodityLot = {
      lotId,
      originCompanyId: companyId,
      currentHolderCompanyId: companyId,
      itemId,
      quantity,
      reservationId,
      status: 'RESERVED_OFF_CHAIN',
      stateHash,
      createdAtTick: currentTick,
    };

    this.lots.set(lotId, newLot);
    return newLot;
  }

  /**
   * Unpack settled lot directly into the buyer's factory inventory
   */
  public async unpackLotToInventory(
    lotId: string,
    receiverCompanyId: string,
    currentTick: number
  ): Promise<void> {
    if (this.circuitBreakerTripped) {
      throw new Error(`[Circuit Breaker Active] Unpacking halted: ${this.circuitBreakerReason}`);
    }

    const lot = this.lots.get(lotId);
    if (!lot) {
      throw new Error(`Lot "${lotId}" not found`);
    }

    validateLotTransition(lot.status, 'CONSUMED_UNPACKED');

    const originCompany = this.engine.getCompany(lot.originCompanyId);
    const receiverCompany = this.engine.getCompany(receiverCompanyId);

    if (!originCompany || !receiverCompany) {
      throw new Error('Participating companies not found');
    }

    // Deduct from seller reserved
    const originStock = originCompany.inventory[lot.itemId];
    if (originStock.reserved < lot.quantity) {
      throw new Error('Invariant violation: reserved quantity less than lot quantity');
    }
    originStock.reserved -= lot.quantity;

    // Credit to buyer available
    const receiverStock = receiverCompany.inventory[lot.itemId];
    receiverStock.available += lot.quantity;

    // Finalize state
    lot.status = 'CONSUMED_UNPACKED';
    lot.settledAtTick = currentTick;
  }

  /**
   * Cancel reservation and restore materials to available inventory
   */
  public async revertReservation(lotId: string, currentTick: number): Promise<void> {
    const lot = this.lots.get(lotId);
    if (!lot) {
      throw new Error(`Lot "${lotId}" not found`);
    }

    validateLotTransition(lot.status, 'CANCELLED_RESTORED');

    const company = this.engine.getCompany(lot.originCompanyId);
    if (!company) {
      throw new Error(`Origin company "${lot.originCompanyId}" not found`);
    }

    const stock = company.inventory[lot.itemId];
    if (stock.reserved < lot.quantity) {
      throw new Error('Invariant violation: reserved quantity less than lot quantity');
    }

    stock.reserved -= lot.quantity;
    stock.available += lot.quantity;

    lot.status = 'CANCELLED_RESTORED';
    lot.settledAtTick = currentTick;
  }

  // --- TOKENIZATION VOUCHER GENERATION (FASE 3 READY) ---

  /**
   * Emit EIP-712 anti-replay authorization voucher
   */
  public generateEip712Voucher(
    lotId: string,
    chainId: number = 8453, // Base Mainnet / Sepolia
    verifyingContract: string = '0xGigaForgeTradeEscrow1155'
  ): Eip712LotVoucher {
    const lot = this.lots.get(lotId);
    if (!lot) {
      throw new Error(`Lot "${lotId}" not found`);
    }

    validateLotTransition(lot.status, 'TOKENIZED_RECEIPT');

    const nonce = (this.accountNonces.get(lot.originCompanyId) ?? 0) + 1;
    this.accountNonces.set(lot.originCompanyId, nonce);

    const expirationTimestamp = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity

    // Simulated ECDSA signature over EIP-712 struct
    const signature = `0xsim_sig_${lot.stateHash}_nonce_${nonce}`;

    lot.status = 'TOKENIZED_RECEIPT';

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
  }

  // --- SETTLEMENT PROVIDER (ESCROW & SETTLEMENT) ---

  /**
   * Create trade escrow record locking buyer payment and 20% seller collateral
   */
  public async createEscrow(
    lot: CommodityLot,
    buyerCompanyId: string,
    price: number,
    deadlineTick: number
  ): Promise<TradeEscrowRecord> {
    if (this.circuitBreakerTripped) {
      throw new Error(`[Circuit Breaker Active] Escrow creation halted: ${this.circuitBreakerReason}`);
    }

    assertSafeInteger(price, 'price');
    assertSafeInteger(deadlineTick, 'deadlineTick');
    if (price <= 0) {
      throw new Error('Agreed price must be a positive integer');
    }

    validateLotTransition(lot.status, 'IN_ESCROW');

    const seller = this.engine.getCompany(lot.originCompanyId);
    const buyer = this.engine.getCompany(buyerCompanyId);

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
    seller.credits -= sellerCollateral;
    buyer.credits -= price;

    lot.status = 'IN_ESCROW';

    const escrowId = `esc_${this.engine.getCurrentTick()}_${++this.escrowCounter}`;
    const record: TradeEscrowRecord = {
      escrowId,
      lotId: lot.lotId,
      sellerCompanyId: seller.companyId,
      buyerCompanyId: buyer.companyId,
      agreedPriceAmount: price,
      currencyType: 'INTERNAL_CREDITS',
      sellerCollateralAmount: sellerCollateral,
      deadlineTick,
      settlementState: 'LOCKED',
    };

    this.escrows.set(escrowId, record);
    return record;
  }

  /**
   * Verify delivery, execute payment minus 2% burn, return collateral, and unpack goods
   */
  public async verifyAndSettleDelivery(
    escrowId: string,
    currentTick: number
  ): Promise<{ settled: boolean; txReference: string }> {
    if (this.circuitBreakerTripped) {
      throw new Error(`[Circuit Breaker Active] Settlement halted: ${this.circuitBreakerReason}`);
    }

    const escrow = this.escrows.get(escrowId);
    if (!escrow) {
      throw new Error(`Escrow "${escrowId}" not found`);
    }

    if (escrow.settlementState !== 'LOCKED') {
      throw new Error(`Escrow state is "${escrow.settlementState}", expected "LOCKED"`);
    }

    const lot = this.lots.get(escrow.lotId);
    if (!lot) {
      throw new Error(`Associated lot "${escrow.lotId}" not found`);
    }

    const seller = this.engine.getCompany(escrow.sellerCompanyId);
    const buyer = this.engine.getCompany(escrow.buyerCompanyId);
    if (!seller || !buyer) {
      throw new Error('Counterparties not found');
    }

    // Transition lot to SETTLED_PENDING_CLAIM
    validateLotTransition(lot.status, 'SETTLED_PENDING_CLAIM');
    lot.status = 'SETTLED_PENDING_CLAIM';

    // Unpack immediately to buyer inventory
    await this.unpackLotToInventory(lot.lotId, buyer.companyId, currentTick);

    // Release 20% collateral back to seller
    seller.credits += escrow.sellerCollateralAmount;

    // 2% market fee burned
    const marketFee = Math.floor((escrow.agreedPriceAmount * 2) / 100);
    const netSellerPayment = escrow.agreedPriceAmount - marketFee;
    seller.credits += netSellerPayment;

    // Reputation bonus for clean fulfillment
    seller.reputation += 5;
    buyer.reputation += 5;

    escrow.settlementState = 'RELEASED_TO_BUYER';
    escrow.settledAtTick = currentTick;

    const txReference = `gf_tx_${currentTick}_${escrow.escrowId}`;
    return { settled: true, txReference };
  }

  // --- AUTOMATED CIRCUIT BREAKER & RECONCILIATION ---

  /**
   * Reconcile all company reserved stocks against sum of active CommodityLots.
   * If discrepancy != 0, trips the circuit breaker and freezes all lot/escrow operations.
   */
  public async reconcileLedgerState(): Promise<{
    discrepanciesFound: number;
    haltedLots: string[];
    isCircuitBreakerTripped: boolean;
  }> {
    let discrepanciesFound = 0;
    const haltedLots: string[] = [];

    // Calculate sum of active lots per company and item
    const expectedReservedMap = new Map<string, number>();

    for (const lot of this.lots.values()) {
      if (
        lot.status === 'RESERVED_OFF_CHAIN' ||
        lot.status === 'TOKENIZED_RECEIPT' ||
        lot.status === 'IN_ESCROW' ||
        lot.status === 'SETTLED_PENDING_CLAIM'
      ) {
        const key = `${lot.originCompanyId}:${lot.itemId}`;
        const currentSum = expectedReservedMap.get(key) ?? 0;
        expectedReservedMap.set(key, currentSum + lot.quantity);
      }
    }

    // Check against live company inventories
    for (const company of this.engine.getAllCompanies()) {
      for (const [itemId, stock] of Object.entries(company.inventory)) {
        const key = `${company.companyId}:${itemId}`;
        const activeLotsSum = expectedReservedMap.get(key) ?? 0;

        if (stock.reserved !== activeLotsSum) {
          discrepanciesFound += 1;
          this.circuitBreakerTripped = true;
          this.circuitBreakerReason = `Discrepancy detected for company ${company.companyId} item ${itemId}: inventory.reserved (${stock.reserved}) !== activeLotsSum (${activeLotsSum})`;

          // Collect affected lots
          for (const lot of this.lots.values()) {
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
}
