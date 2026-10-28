/**
 * `inventory_reservations` repository — the S4 hot spot.
 *
 * `reserve` is the only place that moves stock from `available_qty` to
 * `reserved_qty`, and it does so in one unit of work with the reservation row:
 * - the balance update is guarded (`available_qty >= ?`), so an over-reserve
 *   cannot write a negative balance;
 * - the reservation insert carries the PRIMARY KEY and, via migration 2, the
 *   UNIQUE index on `lot_id`, so a duplicate reservation is rejected by SQLite
 *   *after* the balance moved — which is exactly the case the rollback tests
 *   pin: no partial movement survives the rejection.
 *
 * `release` performs the inverse movement (reserved -> available at the origin
 * for `REVERTED`, or -> the recipient for `UNPACKED`) and flips the row status.
 */

import type { Database } from 'bun:sqlite';

import { filterFlag, toInventoryReservation, type ReservationRow } from '../rows.ts';
import { runAtomic } from '../transaction.ts';
import {
  InsufficientStockError,
  type InventoryReservationRecord,
  type ReleaseReservationRequest,
  type ReservationRequest,
  type ReservationStatus,
} from './types.ts';
import { assertNonEmptyString, assertNonNegativeInteger, assertPositiveInteger } from './validate.ts';

const SELECT_ONE_SQL = `
SELECT reservation_id, company_id, item_id, quantity, lot_id, status, created_at_tick
FROM inventory_reservations WHERE reservation_id = ?`;

const SELECT_BY_LOT_SQL = `SELECT reservation_id, company_id, item_id, quantity, lot_id, status, created_at_tick
FROM inventory_reservations WHERE lot_id = ?`;

const LIST_SQL = `SELECT reservation_id, company_id, item_id, quantity, lot_id, status, created_at_tick
FROM inventory_reservations
WHERE (? = 1 OR company_id = ?)
  AND (? = 1 OR lot_id = ?)
  AND (? = 1 OR status = ?)
ORDER BY reservation_id`;

const SELECT_STOCK_SQL = `
SELECT company_id, item_id, available_qty, reserved_qty, updated_at_tick
FROM inventories WHERE company_id = ? AND item_id = ?`;

/** Guarded transfer: 0 rows changed means the balance was not sufficient. */
const MOVE_TO_RESERVED_SQL = `
UPDATE inventories
SET available_qty = available_qty - ?, reserved_qty = reserved_qty + ?, updated_at_tick = ?
WHERE company_id = ? AND item_id = ? AND available_qty >= ?`;

/** `COALESCE` keeps the previous tick when the caller does not supply one. */
const DEBIT_RESERVED_SQL = `
UPDATE inventories SET reserved_qty = reserved_qty - ?, updated_at_tick = COALESCE(?, updated_at_tick)
WHERE company_id = ? AND item_id = ? AND reserved_qty >= ?`;

const CREDIT_AVAILABLE_SQL = `
INSERT INTO inventories (id, company_id, item_id, available_qty, reserved_qty, updated_at_tick)
VALUES (?, ?, ?, ?, 0, COALESCE(?, 0))
ON CONFLICT(company_id, item_id) DO UPDATE SET
  available_qty = available_qty + excluded.available_qty,
  updated_at_tick = COALESCE(excluded.updated_at_tick, inventories.updated_at_tick)`;

const INSERT_SQL = `
INSERT INTO inventory_reservations
  (reservation_id, company_id, item_id, quantity, lot_id, status, created_at_tick)
VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)`;

const UPDATE_STATUS_SQL =
  'UPDATE inventory_reservations SET status = ? WHERE reservation_id = ?';

export interface ReservationListFilter {
  readonly companyId?: string;
  readonly lotId?: string;
  readonly status?: ReservationStatus;
}

export class ReservationRepository {
  constructor(private readonly database: Database) {}

  load(reservationId: string): InventoryReservationRecord | null {
    const row = this.database
      .query<ReservationRow>(SELECT_ONE_SQL)
      .get(reservationId);
    return row ? toInventoryReservation(row) : null;
  }

  loadByLot(lotId: string): InventoryReservationRecord | null {
    const row = this.database.query<ReservationRow>(SELECT_BY_LOT_SQL).get(lotId);
    return row ? toInventoryReservation(row) : null;
  }

  list(filter: ReservationListFilter = {}): InventoryReservationRecord[] {
    const rows = this.database
      .query<ReservationRow>(LIST_SQL)
      .all(
        ...filterFlag(filter.companyId),
        ...filterFlag(filter.lotId),
        ...filterFlag(filter.status),
      );
    return rows.map(toInventoryReservation);
  }

  /** Lock `quantity` of `itemId` into a new reservation (available -> reserved). */
  reserve(request: ReservationRequest): InventoryReservationRecord {
    assertNonEmptyString(request.reservationId, 'reservationId');
    assertNonEmptyString(request.lotId, 'lotId');
    assertPositiveInteger(request.quantity, 'quantity');
    assertNonNegativeInteger(request.createdAtTick, 'createdAtTick');

    return runAtomic(this.database, () => {
      const stock = this.database
        .query<{ available_qty: number }>(SELECT_STOCK_SQL)
        .get(request.companyId, request.itemId);
      const available = stock?.available_qty ?? 0;
      if (available < request.quantity) {
        throw new InsufficientStockError(
          request.companyId,
          request.itemId,
          request.quantity,
          available,
        );
      }

      const moved = this.database
        .query(MOVE_TO_RESERVED_SQL)
        .run(
          request.quantity,
          request.quantity,
          request.createdAtTick,
          request.companyId,
          request.itemId,
          request.quantity,
        );
      if (moved.changes !== 1) {
        throw new InsufficientStockError(
          request.companyId,
          request.itemId,
          request.quantity,
          available,
        );
      }

      this.database
        .query(INSERT_SQL)
        .run(
          request.reservationId,
          request.companyId,
          request.itemId,
          request.quantity,
          request.lotId,
          request.createdAtTick,
        );

      return {
        reservationId: request.reservationId,
        companyId: request.companyId,
        itemId: request.itemId,
        quantity: request.quantity,
        lotId: request.lotId,
        status: 'ACTIVE' as const,
        createdAtTick: request.createdAtTick,
      };
    });
  }

  /** Close an active reservation and move its stock out of `reserved`. */
  release(request: ReleaseReservationRequest): InventoryReservationRecord {
    return runAtomic(this.database, () => {
      const record = this.load(request.reservationId);
      if (!record) {
        throw new Error(`Reservation "${request.reservationId}" not found`);
      }
      if (record.status !== 'ACTIVE') {
        throw new Error(
          `Reservation "${request.reservationId}" is "${record.status}", expected "ACTIVE"`,
        );
      }

      const debited = this.database
        .query(DEBIT_RESERVED_SQL)
        .run(
          record.quantity,
          request.atTick ?? null,
          record.companyId,
          record.itemId,
          record.quantity,
        );
      if (debited.changes !== 1) {
        throw new Error(
          `Invariant violation: reserved ${record.companyId}.${record.itemId} is less than ` +
            `the reservation quantity ${record.quantity}`,
        );
      }

      const recipientCompanyId =
        request.status === 'REVERTED'
          ? record.companyId
          : (request.recipientCompanyId ?? record.companyId);
      this.database
        .query(CREDIT_AVAILABLE_SQL)
        .run(
          `${recipientCompanyId}:${record.itemId}`,
          recipientCompanyId,
          record.itemId,
          record.quantity,
          request.atTick ?? null,
        );

      this.database.query(UPDATE_STATUS_SQL).run(request.status, record.reservationId);

      return { ...record, status: request.status };
    });
  }
}
