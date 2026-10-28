/**
 * `commodity_lots` repository (Pre-Web3 packaging of reserved materials).
 *
 * `reservation_id` is UNIQUE (migration 2) and references
 * `inventory_reservations`, so a lot cannot point at a missing reservation and
 * two lots cannot share one reservation.
 *
 * `setStatus` persists a state change without validating the transition: the
 * lot state machine (`validateLotTransition`) stays a domain rule, and this
 * repository is the persistence primitive T5 composes inside `runAtomic`.
 */

import type { Database } from 'bun:sqlite';

import type { CommodityLot, LotStatus } from '../../domain/web3DomainModel.ts';
import { filterFlag, toCommodityLot, type LotRow } from '../rows.ts';
import { runAtomic } from '../transaction.ts';

const COLUMNS = `lot_id, origin_company_id, current_holder_company_id, item_id, quantity,
  reservation_id, status, state_hash, created_at_tick, settled_at_tick`;

const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM commodity_lots WHERE lot_id = ?`;

const LIST_SQL = `SELECT ${COLUMNS} FROM commodity_lots
WHERE (? = 1 OR status = ?)
  AND (? = 1 OR current_holder_company_id = ?)
  AND (? = 1 OR origin_company_id = ?)
ORDER BY lot_id`;

const UPSERT_SQL = `
INSERT INTO commodity_lots (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(lot_id) DO UPDATE SET
  origin_company_id = excluded.origin_company_id,
  current_holder_company_id = excluded.current_holder_company_id,
  item_id = excluded.item_id,
  quantity = excluded.quantity,
  reservation_id = excluded.reservation_id,
  status = excluded.status,
  state_hash = excluded.state_hash,
  created_at_tick = excluded.created_at_tick,
  settled_at_tick = excluded.settled_at_tick`;

const SET_STATUS_SQL = 'UPDATE commodity_lots SET status = ?, settled_at_tick = ? WHERE lot_id = ?';

export interface LotListFilter {
  readonly status?: LotStatus;
  readonly holderCompanyId?: string;
  readonly originCompanyId?: string;
}

export class LotRepository {
  constructor(private readonly database: Database) {}

  load(lotId: string): CommodityLot | null {
    const row = this.database.query<LotRow>(SELECT_ONE_SQL).get(lotId);
    return row ? toCommodityLot(row) : null;
  }

  list(filter: LotListFilter = {}): CommodityLot[] {
    const rows = this.database
      .query<LotRow>(LIST_SQL)
      .all(
        ...filterFlag(filter.status),
        ...filterFlag(filter.holderCompanyId),
        ...filterFlag(filter.originCompanyId),
      );
    return rows.map(toCommodityLot);
  }

  save(lot: CommodityLot): CommodityLot {
    runAtomic(this.database, () => {
      this.database
        .query(UPSERT_SQL)
        .run(
          lot.lotId,
          lot.originCompanyId,
          lot.currentHolderCompanyId,
          lot.itemId,
          lot.quantity,
          lot.reservationId,
          lot.status,
          lot.stateHash,
          lot.createdAtTick,
          lot.settledAtTick ?? null,
        );
    });
    return lot;
  }

  /**
   * Persist a lot state change. `settledAtTick` defaults to `null` (cleared), so
   * a caller that wants to keep or set a settlement tick passes it explicitly.
   */
  setStatus(lotId: string, status: LotStatus, settledAtTick: number | null = null): void {
    runAtomic(this.database, () => {
      const result = this.database.query(SET_STATUS_SQL).run(status, settledAtTick, lotId);
      if (result.changes !== 1) {
        throw new Error(`Commodity lot "${lotId}" not found`);
      }
    });
  }
}
