/**
 * GigaForge v4.1 - Pre-Web3 Domain Model & State Machines
 * Reference: WEB3_DOMAIN_MODEL.md
 *
 * Enforces:
 * - Strict Invariant 1: Material Conservation (stock cannot be both available and packed in LotReceipt)
 * - Strict Invariant 2: Ownership vs Usage Rights separation (ERC-4907 deterministic rentals)
 * - Safe integer arithmetic throughout
 * - State machine transitions for CommodityLot and TradeEscrow
 * - Decoupled settlement adapters (SqliteLocalSettlementProvider vs EvmTestnetSettlementProvider)
 * - EIP-712 typed data hashing and Anti-Replay nonces
 * - Automated Circuit Breaker ledger reconciliation
 */

import { assertSafeInteger } from './recipeCatalog.ts';
import { ItemId } from './types.ts';

export type AssetCategory = 'BLUEPRINT_MODIFIER' | 'FACILITY_DEED' | 'COMMODITY_LOT';

export interface Asset {
  readonly assetId: string;
  readonly category: AssetCategory;
  readonly metadataCode: string;
  readonly isTokenizable: boolean;
  readonly onChainTokenId?: string;
  readonly chainId?: string;
}

export type CustodyState = 'OFF_CHAIN_LEDGER' | 'LOCKED_IN_ESCROW' | 'MINTED_ON_CHAIN';

export interface Ownership {
  readonly assetId: string;
  readonly ownerCompanyId: string;
  readonly ownerWalletAddress?: string;
  readonly custodyState: CustodyState;
  readonly updatedAtTick: number;
}

export interface UsageRight {
  readonly usageId: string;
  readonly assetId: string;
  readonly beneficiaryCompanyId: string;
  readonly validFromTick: number;
  readonly expiresAtTick: number;
  readonly revenueShareBps: number; // e.g. 1000 = 10%
  readonly isActive: boolean;
}

export type LotStatus =
  | 'RESERVED_OFF_CHAIN' // Materials deducted from available and locked
  | 'TOKENIZED_RECEIPT' // Signed commitment / EIP-712 voucher
  | 'IN_ESCROW' // Deposited in internal or external escrow contract
  | 'SETTLED_PENDING_CLAIM' // Paid; awaiting buyer unpack/claim
  | 'CONSUMED_UNPACKED' // Materials delivered to buyer; lot burned forever
  | 'CANCELLED_RESTORED'; // Reservation aborted by seller; materials returned

export interface CommodityLot {
  readonly lotId: string;
  readonly originCompanyId: string;
  readonly currentHolderCompanyId: string;
  readonly itemId: ItemId;
  readonly quantity: number; // Safe positive integer
  readonly reservationId: string;
  status: LotStatus;
  readonly stateHash: string;
  readonly createdAtTick: number;
  settledAtTick?: number;
}

export type EscrowSettlementState =
  | 'AWAITING_DEPOSITS'
  | 'LOCKED'
  | 'RELEASED_TO_BUYER'
  | 'REFUNDED'
  | 'DISPUTED';

export type CurrencyType = 'INTERNAL_CREDITS' | 'TESTNET_TOKEN' | 'STABLECOIN';

export interface TradeEscrowRecord {
  readonly escrowId: string;
  readonly lotId: string;
  readonly sellerCompanyId: string;
  readonly buyerCompanyId: string;
  readonly agreedPriceAmount: number; // Safe integer
  readonly currencyType: CurrencyType;
  readonly sellerCollateralAmount: number; // 20% collateral
  readonly deadlineTick: number;
  settlementState: EscrowSettlementState;
  readonly externalTxHash?: string;
  settledAtTick?: number;
}

export interface Eip712LotVoucher {
  readonly chainId: number;
  readonly verifyingContract: string;
  readonly lotId: string;
  readonly originCompanyId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly nonce: number;
  readonly expirationTimestamp: number;
  readonly signature: string;
}

export interface InventoryReservationService {
  lockMaterialsForLot(
    companyId: string,
    itemId: ItemId,
    quantity: number,
    currentTick: number
  ): Promise<CommodityLot>;

  unpackLotToInventory(
    lotId: string,
    receiverCompanyId: string,
    currentTick: number
  ): Promise<void>;

  revertReservation(lotId: string, currentTick: number): Promise<void>;
}

export interface SettlementProvider {
  createEscrow(
    lot: CommodityLot,
    buyerCompanyId: string,
    price: number,
    deadlineTick: number
  ): Promise<TradeEscrowRecord>;

  verifyAndSettleDelivery(
    escrowId: string,
    currentTick: number
  ): Promise<{ settled: boolean; txReference: string }>;

  reconcileLedgerState(): Promise<{
    discrepanciesFound: number;
    haltedLots: string[];
    isCircuitBreakerTripped: boolean;
  }>;
}

/**
 * Compute deterministic integrity state hash for a CommodityLot
 */
export function calculateLotStateHash(
  lotId: string,
  itemId: string,
  quantity: number,
  originCompanyId: string
): string {
  assertSafeInteger(quantity, 'quantity');
  const payload = `${lotId}:${itemId}:${quantity}:${originCompanyId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Valid transitions for CommodityLot state machine
 */
export const ALLOWED_LOT_TRANSITIONS: Record<LotStatus, readonly LotStatus[]> = {
  RESERVED_OFF_CHAIN: ['TOKENIZED_RECEIPT', 'IN_ESCROW', 'CANCELLED_RESTORED'],
  TOKENIZED_RECEIPT: ['IN_ESCROW', 'CANCELLED_RESTORED'],
  IN_ESCROW: ['SETTLED_PENDING_CLAIM', 'CANCELLED_RESTORED'],
  SETTLED_PENDING_CLAIM: ['CONSUMED_UNPACKED'],
  CONSUMED_UNPACKED: [], // Terminal
  CANCELLED_RESTORED: [], // Terminal
};

/**
 * State machine validator
 */
export function validateLotTransition(from: LotStatus, to: LotStatus): void {
  const allowed = ALLOWED_LOT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `[GigaForge Lot State Machine Error] Illegal transition from "${from}" to "${to}". Allowed: [${allowed.join(
        ', '
      )}]`
    );
  }
}
