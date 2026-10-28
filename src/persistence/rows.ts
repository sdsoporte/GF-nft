/**
 * Row shapes and row -> domain mappers for the persistence layer.
 *
 * Reading lives here rather than inside the repositories so the mapping is
 * inspectable in one place: every column migration 1/2 defines appears exactly
 * once on the way back out, and the write side in `repos/*` binds the same set.
 * Optional domain fields are omitted (not set to `undefined`) when the column is
 * NULL, so a write -> read round trip is a deep equal rather than a comparison
 * with holes.
 */

import type {
  CompanyState,
  ContractStatus,
  IndustrialClass,
  InventoryMap,
  InventoryStock,
  ItemId,
  LinePriority,
  LineStatus,
  ProductionBatch,
  ProductionLine,
  RecipeId,
  SupplyContract,
} from '../domain/types.ts';
import type {
  CommodityLot,
  CurrencyType,
  EscrowSettlementState,
  LotStatus,
  TradeEscrowRecord,
} from '../domain/web3DomainModel.ts';
import type { McpAuditLogEntry, McpGrant, McpPhaseMode, McpScope } from '../mcp/types.ts';
import type {
  CompanyRecord,
  InventoryReservationRecord,
  ReservationStatus,
} from './repos/types.ts';

/** Canonical item order, matching the inventories CHECK constraint. */
export const ITEM_IDS: readonly ItemId[] = [
  'RAW_ORE',
  'IRON_INGOT',
  'STEEL_PLATE',
  'HEAVY_ALLOY',
  'MECH_FRAME',
  'CTRL_CIRCUIT',
  'POWER_MODULE',
  'IND_TURBINE',
  'MEGAMACHINE_PART',
];

// --- scalar helpers ---------------------------------------------------------

export function toBoolean(value: number): boolean {
  return value === 1;
}

export function toIntegerFlag(value: boolean): number {
  return value ? 1 : 0;
}

export function toNullish<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/**
 * Binding pair for an optional `list` filter, used with the static predicate
 * `(? = 1 OR column = ?)`.
 *
 * Absent filter -> `[1, null]`: SQLite evaluates `1 = 1` as true, so the second
 * binding is never compared (comparing against NULL would otherwise make the
 * whole predicate NULL and silently drop every row). Present filter ->
 * `[0, value]`, which reduces the predicate to `column = ?`.
 */
export function filterFlag<T>(value: T | undefined): [number, T | null] {
  return value === undefined ? [1, null] : [0, value];
}

function parseStringArray(json: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`Corrupt ${label} JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Corrupt ${label} JSON: expected an array of strings`);
  }
  return parsed as string[];
}

/** Inventory with every item present at zero, matching the domain map shape. */
export function emptyInventory(): InventoryMap {
  const inventory = {} as InventoryMap;
  for (const itemId of ITEM_IDS) {
    inventory[itemId] = { available: 0, reserved: 0 };
  }
  return inventory;
}

// --- row shapes -------------------------------------------------------------

export interface CompanyRow {
  readonly company_id: string;
  readonly name: string;
  readonly industrial_class: string;
  readonly is_npc: number;
  readonly credits: number;
  readonly energy: number;
  readonly max_energy_storage: number;
  readonly energy_generation_per_tick: number;
  readonly installed_turbines_r7: number;
  readonly contributed_megamachine_parts_r8: number;
  readonly reputation: number;
  readonly maintenance_paid_ticks: number;
  readonly created_at_utc: string;
  readonly updated_at_utc: string;
}

export interface InventoryRow {
  readonly company_id: string;
  readonly item_id: string;
  readonly available_qty: number;
  readonly reserved_qty: number;
  readonly updated_at_tick: number;
}

export interface ProductionLineRow {
  readonly line_id: string;
  readonly company_id: string;
  readonly priority: number;
  readonly status: string;
  readonly current_recipe_id: string | null;
  readonly active_batch_recipe_id: string | null;
  readonly active_batch_target_batches: number | null;
  readonly active_batch_completed_batches: number | null;
  readonly active_batch_progress_ticks: number | null;
  readonly active_batch_total_duration_ticks: number | null;
  readonly active_batch_energy_per_tick: number | null;
  readonly active_batch_energy_remainder: number | null;
  readonly total_batches_produced: number;
  readonly last_action_tick: number;
}

export interface ContractRow {
  readonly contract_id: string;
  readonly seller_company_id: string;
  readonly buyer_company_id: string;
  readonly item_id: string;
  readonly total_quantity: number;
  readonly delivered_quantity: number;
  readonly unit_price_credits: number;
  readonly total_value_credits: number;
  readonly collateral_seller_credits: number;
  readonly created_at_tick: number;
  readonly deadline_tick: number;
  readonly penalty_per_missing_unit: number;
  readonly status: string;
  readonly settled_at_tick: number | null;
}

export interface LotRow {
  readonly lot_id: string;
  readonly origin_company_id: string;
  readonly current_holder_company_id: string;
  readonly item_id: string;
  readonly quantity: number;
  readonly reservation_id: string;
  readonly status: string;
  readonly state_hash: string;
  readonly created_at_tick: number;
  readonly settled_at_tick: number | null;
}

export interface EscrowRow {
  readonly escrow_id: string;
  readonly lot_id: string;
  readonly seller_company_id: string;
  readonly buyer_company_id: string;
  readonly agreed_price_amount: number;
  readonly currency_type: string;
  readonly seller_collateral_amount: number;
  readonly deadline_tick: number;
  readonly settlement_state: string;
  readonly external_tx_hash: string | null;
  readonly settled_at_tick: number | null;
}

export interface ReservationRow {
  readonly reservation_id: string;
  readonly company_id: string;
  readonly item_id: string;
  readonly quantity: number;
  readonly lot_id: string;
  readonly status: string;
  readonly created_at_tick: number;
}

export interface GrantRow {
  readonly grant_id: string;
  readonly token: string;
  readonly player_id: string;
  readonly company_id: string;
  readonly match_id: string;
  readonly phase_mode: string;
  readonly scopes_json: string;
  readonly resource_allowlist_json: string;
  readonly max_read_per_minute: number;
  readonly max_write_per_minute: number;
  readonly max_write_per_match: number;
  readonly created_at_utc: string;
  readonly expires_at_utc: string;
  readonly revoked: number;
}

export interface AuditLogRow {
  readonly id: string;
  readonly timestamp_utc: string;
  readonly tick: number;
  readonly grant_id: string;
  readonly company_id: string;
  readonly tool_name: string;
  readonly payload_hash: string;
  readonly idempotency_key: string | null;
  readonly result_code: string;
  readonly execution_time_ms: number;
}

// --- row -> domain ----------------------------------------------------------

export function toInventoryStock(row: InventoryRow): InventoryStock {
  return { available: row.available_qty, reserved: row.reserved_qty };
}

export function toInventoryMap(rows: readonly InventoryRow[]): InventoryMap {
  const inventory = emptyInventory();
  for (const row of rows) {
    inventory[row.item_id as ItemId] = toInventoryStock(row);
  }
  return inventory;
}

export function toProductionBatch(row: ProductionLineRow): ProductionBatch {
  return {
    recipeId: row.active_batch_recipe_id as RecipeId,
    targetBatches: row.active_batch_target_batches as number,
    completedBatches: row.active_batch_completed_batches as number,
    progressTicks: row.active_batch_progress_ticks as number,
    totalDurationTicks: row.active_batch_total_duration_ticks as number,
    energyPerTick: row.active_batch_energy_per_tick as number,
    energyRemainder: row.active_batch_energy_remainder as number,
  };
}

export function toProductionLine(row: ProductionLineRow): ProductionLine {
  return {
    lineId: row.line_id,
    companyId: row.company_id,
    priority: row.priority as LinePriority,
    status: row.status as LineStatus,
    currentRecipeId: row.current_recipe_id === null ? null : (row.current_recipe_id as RecipeId),
    activeBatch: row.active_batch_recipe_id === null ? null : toProductionBatch(row),
    totalBatchesProduced: row.total_batches_produced,
    lastActionTick: row.last_action_tick,
  };
}

export function toCompanyRecord(
  row: CompanyRow,
  inventory: InventoryMap,
  lines: readonly ProductionLine[],
): CompanyRecord {
  const state: CompanyState = {
    companyId: row.company_id,
    name: row.name,
    industrialClass: row.industrial_class as IndustrialClass,
    isNPC: toBoolean(row.is_npc),
    credits: row.credits,
    energy: row.energy,
    maxEnergyStorage: row.max_energy_storage,
    energyGenerationPerTick: row.energy_generation_per_tick,
    installedTurbinesR7: row.installed_turbines_r7,
    contributedMegamachinePartsR8: row.contributed_megamachine_parts_r8,
    reputation: row.reputation,
    inventory,
    lines: [...lines],
    maintenancePaidTicks: row.maintenance_paid_ticks,
  };
  return { ...state, createdAtUtc: row.created_at_utc, updatedAtUtc: row.updated_at_utc };
}

export function toSupplyContract(row: ContractRow): SupplyContract {
  return {
    contractId: row.contract_id,
    sellerCompanyId: row.seller_company_id,
    buyerCompanyId: row.buyer_company_id,
    itemId: row.item_id as ItemId,
    totalQuantity: row.total_quantity,
    deliveredQuantity: row.delivered_quantity,
    unitPriceCredits: row.unit_price_credits,
    totalValueCredits: row.total_value_credits,
    collateralSellerCredits: row.collateral_seller_credits,
    createdAtTick: row.created_at_tick,
    deadlineTick: row.deadline_tick,
    penaltyPerMissingUnit: row.penalty_per_missing_unit,
    status: row.status as ContractStatus,
    ...(row.settled_at_tick === null ? {} : { settledAtTick: row.settled_at_tick }),
  };
}

export function toCommodityLot(row: LotRow): CommodityLot {
  return {
    lotId: row.lot_id,
    originCompanyId: row.origin_company_id,
    currentHolderCompanyId: row.current_holder_company_id,
    itemId: row.item_id as ItemId,
    quantity: row.quantity,
    reservationId: row.reservation_id,
    status: row.status as LotStatus,
    stateHash: row.state_hash,
    createdAtTick: row.created_at_tick,
    ...(row.settled_at_tick === null ? {} : { settledAtTick: row.settled_at_tick }),
  };
}

export function toTradeEscrow(row: EscrowRow): TradeEscrowRecord {
  return {
    escrowId: row.escrow_id,
    lotId: row.lot_id,
    sellerCompanyId: row.seller_company_id,
    buyerCompanyId: row.buyer_company_id,
    agreedPriceAmount: row.agreed_price_amount,
    currencyType: row.currency_type as CurrencyType,
    sellerCollateralAmount: row.seller_collateral_amount,
    deadlineTick: row.deadline_tick,
    settlementState: row.settlement_state as EscrowSettlementState,
    ...(row.external_tx_hash === null ? {} : { externalTxHash: row.external_tx_hash }),
    ...(row.settled_at_tick === null ? {} : { settledAtTick: row.settled_at_tick }),
  };
}

export function toInventoryReservation(row: ReservationRow): InventoryReservationRecord {
  return {
    reservationId: row.reservation_id,
    companyId: row.company_id,
    itemId: row.item_id as ItemId,
    quantity: row.quantity,
    lotId: row.lot_id,
    status: row.status as ReservationStatus,
    createdAtTick: row.created_at_tick,
  };
}

export function toMcpGrant(row: GrantRow): McpGrant {
  return {
    grantId: row.grant_id,
    token: row.token,
    playerId: row.player_id,
    companyId: row.company_id,
    matchId: row.match_id,
    phaseMode: row.phase_mode as McpPhaseMode,
    scopes: parseStringArray(row.scopes_json, 'scopes_json') as McpScope[],
    resourceAllowlist: parseStringArray(row.resource_allowlist_json, 'resource_allowlist_json'),
    quotas: {
      maxReadPerMinute: row.max_read_per_minute,
      maxWritePerMinute: row.max_write_per_minute,
      maxWritePerMatch: row.max_write_per_match,
    },
    createdAtUtc: row.created_at_utc,
    expiresAtUtc: row.expires_at_utc,
    revoked: toBoolean(row.revoked),
  };
}

export function toMcpAuditLog(row: AuditLogRow): McpAuditLogEntry {
  return {
    id: row.id,
    timestampUtc: row.timestamp_utc,
    tick: row.tick,
    grantId: row.grant_id,
    companyId: row.company_id,
    toolName: row.tool_name,
    payloadHash: row.payload_hash,
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
    resultCode: row.result_code,
    executionTimeMs: row.execution_time_ms,
  };
}
