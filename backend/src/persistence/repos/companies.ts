/**
 * `companies` repository: the row columns plus the child collections that make
 * up a `CompanyState`.
 *
 * Reads compose inventory and production-line rows so a restore receives the
 * domain shape directly. Writes touch only the company row; `Repositories`
 * exposes the aggregate write that stores a company with its children in one
 * unit of work.
 */

import type { Database } from 'bun:sqlite';

import {
  toCompanyRecord,
  toInventoryMap,
  type CompanyRow,
  type InventoryRow,
} from '../rows.ts';
import { runAtomic } from '../transaction.ts';
import { InventoryRepository } from './inventory.ts';
import { ProductionLineRepository } from './lines.ts';
import type { CompanyRecord, CompanyWriteInput } from './types.ts';
import { assertNonNegativeInteger } from './validate.ts';

const COLUMNS = `company_id, name, industrial_class, is_npc, credits, energy,
  max_energy_storage, energy_generation_per_tick, installed_turbines_r7,
  contributed_megamachine_parts_r8, reputation, maintenance_paid_ticks,
  created_at_utc, updated_at_utc`;

const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM companies WHERE company_id = ?`;
const SELECT_ALL_SQL = `SELECT ${COLUMNS} FROM companies ORDER BY company_id`;
const SELECT_INVENTORY_SQL = `
SELECT company_id, item_id, available_qty, reserved_qty, updated_at_tick
FROM inventories WHERE company_id = ?`;

/**
 * `created_at_utc` is never overwritten on update (it is excluded from the
 * `DO UPDATE` list), so the original insert time survives an upsert even when
 * the caller passes a different value.
 */
const UPSERT_SQL = `
INSERT INTO companies (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(company_id) DO UPDATE SET
  name = excluded.name,
  industrial_class = excluded.industrial_class,
  is_npc = excluded.is_npc,
  credits = excluded.credits,
  energy = excluded.energy,
  max_energy_storage = excluded.max_energy_storage,
  energy_generation_per_tick = excluded.energy_generation_per_tick,
  installed_turbines_r7 = excluded.installed_turbines_r7,
  contributed_megamachine_parts_r8 = excluded.contributed_megamachine_parts_r8,
  reputation = excluded.reputation,
  maintenance_paid_ticks = excluded.maintenance_paid_ticks,
  updated_at_utc = excluded.updated_at_utc`;

export class CompanyRepository {
  private readonly inventory: InventoryRepository;
  private readonly lines: ProductionLineRepository;

  constructor(private readonly database: Database) {
    this.inventory = new InventoryRepository(database);
    this.lines = new ProductionLineRepository(database);
  }

  load(companyId: string): CompanyRecord | null {
    const row = this.database.query<CompanyRow>(SELECT_ONE_SQL).get(companyId);
    if (!row) return null;
    const inventoryRows = this.database
      .query<InventoryRow>(SELECT_INVENTORY_SQL)
      .all(companyId);
    return toCompanyRecord(row, toInventoryMap(inventoryRows), this.lines.listForCompany(companyId));
  }

  loadAll(): CompanyRecord[] {
    return this.database
      .query<CompanyRow>(SELECT_ALL_SQL)
      .all()
      .map((row) => this.load(row.company_id))
      .filter((record): record is CompanyRecord => record !== null);
  }

  exists(companyId: string): boolean {
    const row = this.database
      .query<{ company_id: string }>('SELECT company_id FROM companies WHERE company_id = ?')
      .get(companyId);
    return row !== null;
  }

  save(input: CompanyWriteInput): void {
    assertNonNegativeInteger(input.maintenancePaidTicks, 'maintenancePaidTicks');
    assertNonNegativeInteger(input.credits, 'credits');
    assertNonNegativeInteger(input.energy, 'energy');

    const now = new Date().toISOString();
    const createdAtUtc = input.createdAtUtc ?? now;
    const updatedAtUtc = input.updatedAtUtc ?? now;

    runAtomic(this.database, () => {
      this.database
        .query(UPSERT_SQL)
        .run(
          input.companyId,
          input.name,
          input.industrialClass,
          input.isNPC ? 1 : 0,
          input.credits,
          input.energy,
          input.maxEnergyStorage,
          input.energyGenerationPerTick,
          input.installedTurbinesR7,
          input.contributedMegamachinePartsR8,
          input.reputation,
          input.maintenancePaidTicks,
          createdAtUtc,
          updatedAtUtc,
        );
    });
  }
}
