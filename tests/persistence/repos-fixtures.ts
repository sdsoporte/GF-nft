/**
 * Shared fixtures for the transactional repository tests.
 *
 * Not a test file on purpose (`bun test` only collects `*.test.ts`), so these
 * helpers can be reused by every `repos-*.test.ts` file without duplicating the
 * sample entities. Each helper that opens a database uses its own temporary
 * directory and removes it afterwards.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'bun:sqlite';

import type {
  CompanyState,
  InventoryMap,
  InventoryStock,
  ItemId,
  ProductionLine,
  SupplyContract,
} from '../../src/domain/types.ts';
import type { CommodityLot, TradeEscrowRecord } from '../../src/domain/web3DomainModel.ts';
import type { McpAuditLogEntry, McpGrant } from '../../src/mcp/types.ts';
import { closeDatabase, openDatabase } from '../../src/persistence/database.ts';
import { migrate } from '../../src/persistence/migrations.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repos/index.ts';
import type {
  CompanyStateWrite,
  InventoryReservationRecord,
} from '../../src/persistence/repos/types.ts';
import { ITEM_IDS } from '../../src/persistence/rows.ts';

export const COMPANY_METAL = 'comp_metal_01';
export const COMPANY_FACTORY = 'comp_factory_02';

/**
 * Tables whose contents must survive (or be rolled back from) a write, with
 * their literal read statements (no identifier interpolation anywhere).
 */
const STATE_TABLE_SQL = {
  companies: 'SELECT rowid, * FROM companies ORDER BY rowid',
  inventories: 'SELECT rowid, * FROM inventories ORDER BY rowid',
  production_lines: 'SELECT rowid, * FROM production_lines ORDER BY rowid',
  b2b_contracts: 'SELECT rowid, * FROM b2b_contracts ORDER BY rowid',
  inventory_reservations: 'SELECT rowid, * FROM inventory_reservations ORDER BY rowid',
  commodity_lots: 'SELECT rowid, * FROM commodity_lots ORDER BY rowid',
  trade_escrows: 'SELECT rowid, * FROM trade_escrows ORDER BY rowid',
  mcp_grants: 'SELECT rowid, * FROM mcp_grants ORDER BY rowid',
  mcp_audit_logs: 'SELECT rowid, * FROM mcp_audit_logs ORDER BY rowid',
} as const;

export type StateTable = keyof typeof STATE_TABLE_SQL;

export const STATE_TABLES = Object.keys(STATE_TABLE_SQL) as readonly StateTable[];

/** Run `work` against a migrated database in a unique temp directory. */
export function withRepositories(work: (repos: Repositories, database: Database) => void): void {
  withDatabase((database) => {
    migrate(database);
    work(createRepositories(database), database);
  });
}

/** Run `work` against an empty, un-migrated database in a unique temp directory. */
export function withDatabase(work: (database: Database, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'gf-repos-'));
  const path = join(directory, 'factory.db');
  const database = openDatabase(path);
  try {
    work(database, path);
  } finally {
    closeDatabase(database);
    rmSync(directory, { force: true, recursive: true });
  }
}

/**
 * Content of every state table, in insertion order, for "the database is
 * unchanged afterwards" assertions (S4/S7).
 */
export function snapshotState(database: Database): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of STATE_TABLES) {
    snapshot[table] = database.query(STATE_TABLE_SQL[table]).all() as unknown[];
  }
  return snapshot;
}

export function countRows(database: Database, table: StateTable): number {
  return database.query(STATE_TABLE_SQL[table]).all().length;
}

/** All nine item ids, every balance zero unless overridden. */
export function fullInventory(
  overrides: Partial<Record<ItemId, InventoryStock>> = {},
): InventoryMap {
  const inventory = {} as InventoryMap;
  for (const itemId of ITEM_IDS) {
    const stock = overrides[itemId];
    inventory[itemId] = {
      available: stock?.available ?? 0,
      reserved: stock?.reserved ?? 0,
    };
  }
  return inventory;
}

/** The company row columns, without inventory or lines. */
export function companyColumns(): Omit<CompanyState, 'inventory' | 'lines'> {
  return {
    companyId: COMPANY_METAL,
    name: 'Metal One',
    industrialClass: 'CLASS_A_METALLURGY',
    isNPC: false,
    credits: 10000,
    energy: 400,
    maxEnergyStorage: 1000,
    energyGenerationPerTick: 20,
    installedTurbinesR7: 1,
    contributedMegamachinePartsR8: 1,
    reputation: 100,
    maintenancePaidTicks: 7,
  };
}

export function sampleLine(overrides: Partial<ProductionLine> = {}): ProductionLine {
  return {
    lineId: 'line_1',
    companyId: COMPANY_METAL,
    priority: 1,
    status: 'RUNNING',
    currentRecipeId: 'R2',
    activeBatch: {
      recipeId: 'R2',
      targetBatches: 3,
      completedBatches: 1,
      progressTicks: 4,
      totalDurationTicks: 10,
      energyPerTick: 3,
      energyRemainder: 1,
    },
    totalBatchesProduced: 5,
    lastActionTick: 12,
    ...overrides,
  };
}

/** A full company aggregate: row columns plus inventory and production lines. */
export function sampleCompanyState(overrides: Partial<CompanyStateWrite> = {}): CompanyStateWrite {
  return {
    ...companyColumns(),
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    updatedAtUtc: '2026-01-01T00:05:00.000Z',
    inventory: fullInventory({
      RAW_ORE: { available: 120, reserved: 20 },
      STEEL_PLATE: { available: 8, reserved: 0 },
      MEGAMACHINE_PART: { available: 3, reserved: 1 },
    }),
    lines: [
      sampleLine(),
      sampleLine({
        lineId: 'line_2',
        priority: 3,
        status: 'IDLE',
        currentRecipeId: null,
        activeBatch: null,
        totalBatchesProduced: 0,
        lastActionTick: 0,
      }),
    ],
    ...overrides,
  };
}

/** Persist the two companies the contract/lot/escrow fixtures reference. */
export function seedCompanies(repos: Repositories): void {
  repos.saveCompanyState(sampleCompanyState());
  repos.saveCompanyState(
    sampleCompanyState({
      companyId: COMPANY_FACTORY,
      name: 'Factory Two',
      industrialClass: 'CLASS_B_MANUFACTURING',
      isNPC: true,
      inventory: fullInventory({
        STEEL_PLATE: { available: 2, reserved: 0 },
        POWER_MODULE: { available: 4, reserved: 0 },
      }),
      lines: [],
    }),
  );
}

export function sampleContract(overrides: Partial<SupplyContract> = {}): SupplyContract {
  return {
    contractId: 'contract_1',
    sellerCompanyId: COMPANY_METAL,
    buyerCompanyId: COMPANY_FACTORY,
    itemId: 'STEEL_PLATE',
    totalQuantity: 10,
    deliveredQuantity: 4,
    unitPriceCredits: 120,
    totalValueCredits: 1200,
    collateralSellerCredits: 240,
    createdAtTick: 10,
    deadlineTick: 40,
    penaltyPerMissingUnit: 10,
    status: 'ACTIVE',
    ...overrides,
  };
}

export function sampleLot(overrides: Partial<CommodityLot> = {}): CommodityLot {
  return {
    lotId: 'lot_1',
    originCompanyId: COMPANY_METAL,
    currentHolderCompanyId: COMPANY_METAL,
    itemId: 'STEEL_PLATE',
    quantity: 5,
    reservationId: 'res_1',
    status: 'RESERVED_OFF_CHAIN',
    stateHash: 'a1b2c3d4',
    createdAtTick: 10,
    ...overrides,
  };
}

export function sampleEscrow(overrides: Partial<TradeEscrowRecord> = {}): TradeEscrowRecord {
  return {
    escrowId: 'esc_1',
    lotId: 'lot_1',
    sellerCompanyId: COMPANY_METAL,
    buyerCompanyId: COMPANY_FACTORY,
    agreedPriceAmount: 600,
    currencyType: 'INTERNAL_CREDITS',
    sellerCollateralAmount: 120,
    deadlineTick: 50,
    settlementState: 'LOCKED',
    ...overrides,
  };
}

/** Reserve 5 STEEL_PLATE for COMPANY_METAL and store the matching lot. */
export function seedLotPair(repos: Repositories): {
  reservation: InventoryReservationRecord;
  lot: CommodityLot;
} {
  const reservation = repos.reservations.reserve({
    reservationId: 'res_1',
    lotId: 'lot_1',
    companyId: COMPANY_METAL,
    itemId: 'STEEL_PLATE',
    quantity: 5,
    createdAtTick: 10,
  });
  const lot = repos.lots.save(sampleLot());
  return { reservation, lot };
}

export function sampleGrant(overrides: Partial<McpGrant> = {}): McpGrant {
  return {
    grantId: 'grant_1',
    token: 'gf_mcp_token_1',
    playerId: 'player_1',
    companyId: COMPANY_METAL,
    matchId: 'match_test',
    phaseMode: 'PHASE_1B_READ_WRITE',
    scopes: ['factory:read', 'production:write'],
    resourceAllowlist: ['line_1', 'line_2'],
    quotas: { maxReadPerMinute: 60, maxWritePerMinute: 12, maxWritePerMatch: 500 },
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    expiresAtUtc: '2026-01-02T00:00:00.000Z',
    revoked: false,
    ...overrides,
  };
}

export function sampleAudit(overrides: Partial<McpAuditLogEntry> = {}): McpAuditLogEntry {
  return {
    id: 'audit_1',
    timestampUtc: '2026-01-01T00:01:00.000Z',
    tick: 5,
    grantId: 'grant_1',
    companyId: COMPANY_METAL,
    toolName: 'set_production_target',
    payloadHash: 'hash_1',
    resultCode: 'SUCCESS',
    executionTimeMs: 3,
    ...overrides,
  };
}
