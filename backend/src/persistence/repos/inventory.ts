/**
 * `inventories` repository: available + reserved per (company, item).
 *
 * The pair `(company_id, item_id)` is UNIQUE in the schema, so a second row for
 * the same item is a constraint failure, not an application-level convention.
 */

import type { Database } from 'bun:sqlite';

import type { InventoryMap, InventoryStock, ItemId } from '../../domain/types.ts';
import { ITEM_IDS, toInventoryMap, toInventoryStock, type InventoryRow } from '../rows.ts';
import { runAtomic } from '../transaction.ts';
import { assertNonNegativeInteger } from './validate.ts';

const SELECT_ALL_SQL = `
SELECT company_id, item_id, available_qty, reserved_qty, updated_at_tick
FROM inventories WHERE company_id = ?`;

const SELECT_ONE_SQL = `
SELECT company_id, item_id, available_qty, reserved_qty, updated_at_tick
FROM inventories WHERE company_id = ? AND item_id = ?`;

const UPSERT_SQL = `
INSERT INTO inventories (id, company_id, item_id, available_qty, reserved_qty, updated_at_tick)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(company_id, item_id) DO UPDATE SET
  available_qty = excluded.available_qty,
  reserved_qty = excluded.reserved_qty,
  updated_at_tick = excluded.updated_at_tick`;

export class InventoryRepository {
  constructor(private readonly database: Database) {}

  /**
   * Every item id for `companyId`; items without a row read as zero stock, so
   * hydration always receives the complete `InventoryMap` shape.
   */
  load(companyId: string): InventoryMap {
    const rows = this.database.query<InventoryRow>(SELECT_ALL_SQL).all(companyId);
    return toInventoryMap(rows);
  }

  loadStock(companyId: string, itemId: ItemId): InventoryStock | null {
    const row = this.database.query<InventoryRow>(SELECT_ONE_SQL).get(companyId, itemId);
    return row ? toInventoryStock(row) : null;
  }

  /** Write all nine item balances for a company in one unit of work. */
  save(companyId: string, inventory: InventoryMap, updatedAtTick = 0): void {
    assertNonNegativeInteger(updatedAtTick, 'updatedAtTick');
    runAtomic(this.database, () => {
      for (const itemId of ITEM_IDS) {
        const stock = inventory[itemId] ?? { available: 0, reserved: 0 };
        assertNonNegativeInteger(stock.available, `${companyId}.${itemId}.available`);
        assertNonNegativeInteger(stock.reserved, `${companyId}.${itemId}.reserved`);
        this.database
          .query(UPSERT_SQL)
          .run(
            `${companyId}:${itemId}`,
            companyId,
            itemId,
            stock.available,
            stock.reserved,
            updatedAtTick,
          );
      }
    });
  }
}
