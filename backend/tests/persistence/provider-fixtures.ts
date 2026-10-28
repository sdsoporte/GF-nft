/**
 * Fixtures for the `SqliteLocalSettlementProvider` tests (T5a).
 *
 * The provider is exercised through its public interface only: every helper
 * here opens a *file-backed* database in its own temporary directory, migrates
 * it, and hands back the repositories plus the provider. Tests may also reason
 * about the rows directly (`snapshotProviderState`), because the point of the
 * task is that the provider's state *is* those rows.
 *
 * Not a test file on purpose (`bun test` collects `*.test.ts` only) and kept
 * free of assertions so each test states its own contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'bun:sqlite';

import { closeDatabase, openDatabase } from '../../src/persistence/database.ts';
import { migrate } from '../../src/persistence/migrations.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repos/index.ts';
import { SqliteLocalSettlementProvider } from '../../src/persistence/SqliteLocalSettlementProvider.ts';
import { fullInventory, sampleCompanyState } from './repos-fixtures.ts';

export const SELLER = 'comp_metal_01';
export const BUYER = 'comp_factory_02';

/** One open file-backed world: database, repositories and the provider on top. */
export interface ProviderWorld {
  readonly path: string;
  readonly database: Database;
  readonly repos: Repositories;
  readonly provider: SqliteLocalSettlementProvider;
}

/**
 * Unique temp directory per test, removed afterwards (including the `-wal` and
 * `-shm` siblings, which is why the whole directory goes rather than the file).
 * The callback is awaited so a test can close/reopen the same path.
 */
export async function withProviderDatabase(
  work: (path: string) => void | Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'gf-provider-'));
  const path = join(directory, 'factory.db');
  try {
    await work(path);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** Open + migrate `path` and build a fresh provider over it. */
export function openWorld(path: string): ProviderWorld {
  const database = openDatabase(path);
  migrate(database);
  return {
    path,
    database,
    repos: createRepositories(database),
    provider: new SqliteLocalSettlementProvider(database),
  };
}

export function closeWorld(world: ProviderWorld): void {
  closeDatabase(world.database);
}

export interface SeedOptions {
  readonly sellerCredits?: number;
  readonly buyerCredits?: number;
  readonly sellerReputation?: number;
  readonly buyerReputation?: number;
  readonly sellerSteel?: number;
  readonly buyerSteel?: number;
}

/**
 * Two settled counterparties with known balances and *zero* reserved stock, so
 * `reconcileLedgerState()` starts clean and every reserved quantity is one the
 * provider itself created.
 */
export function seedSettlementCompanies(repos: Repositories, options: SeedOptions = {}): void {
  repos.saveCompanyState(
    sampleCompanyState({
      companyId: SELLER,
      name: 'Metal One',
      credits: options.sellerCredits ?? 10_000,
      reputation: options.sellerReputation ?? 100,
      inventory: fullInventory({
        STEEL_PLATE: { available: options.sellerSteel ?? 10, reserved: 0 },
        RAW_ORE: { available: 100, reserved: 0 },
      }),
      lines: [],
    }),
  );
  repos.saveCompanyState(
    sampleCompanyState({
      companyId: BUYER,
      name: 'Factory Two',
      industrialClass: 'CLASS_B_MANUFACTURING',
      isNPC: true,
      credits: options.buyerCredits ?? 5_000,
      reputation: options.buyerReputation ?? 50,
      inventory: fullInventory({
        STEEL_PLATE: { available: options.buyerSteel ?? 2, reserved: 0 },
      }),
      lines: [],
    }),
  );
}

/**
 * Every table the provider writes, in a deterministic order. Used for "and
 * nothing else changed" assertions (S4/S7), which is only meaningful if the
 * settlement bookkeeping tables are included too.
 */
const STATE_TABLE_SQL = {
  companies: 'SELECT * FROM companies ORDER BY company_id',
  inventories: 'SELECT * FROM inventories ORDER BY company_id, item_id',
  inventory_reservations: 'SELECT * FROM inventory_reservations ORDER BY reservation_id',
  commodity_lots: 'SELECT * FROM commodity_lots ORDER BY lot_id',
  trade_escrows: 'SELECT * FROM trade_escrows ORDER BY escrow_id',
  settlement_counters: 'SELECT * FROM settlement_counters ORDER BY name',
  account_nonces: 'SELECT * FROM account_nonces ORDER BY company_id',
} as const;

export type ProviderStateTable = keyof typeof STATE_TABLE_SQL;

export const PROVIDER_STATE_TABLES = Object.keys(STATE_TABLE_SQL) as readonly ProviderStateTable[];

export function snapshotProviderState(database: Database): Record<string, unknown[]> {
  const snapshot: Record<string, unknown[]> = {};
  for (const table of PROVIDER_STATE_TABLES) {
    snapshot[table] = database.query(STATE_TABLE_SQL[table]).all() as unknown[];
  }
  return snapshot;
}

export function countRows(database: Database, table: ProviderStateTable): number {
  return database.query(STATE_TABLE_SQL[table]).all().length;
}

/** Seller inventory as the provider persists it: `[available, reserved]`. */
export function steelStock(
  repos: Repositories,
  companyId: string,
): { available: number; reserved: number } {
  const stock = repos.inventory.loadStock(companyId, 'STEEL_PLATE');
  return {
    available: stock?.available ?? -1,
    reserved: stock?.reserved ?? -1,
  };
}

export function creditsOf(repos: Repositories, companyId: string): number {
  const company = repos.companies.load(companyId);
  if (!company) throw new Error(`company ${companyId} is missing from the database`);
  return company.credits;
}

export function reputationOf(repos: Repositories, companyId: string): number {
  const company = repos.companies.load(companyId);
  if (!company) throw new Error(`company ${companyId} is missing from the database`);
  return company.reputation;
}
