/**
 * Repository-facing types: the write inputs and read records that sit between
 * the domain model (`src/domain/types.ts`, `web3DomainModel.ts`, `src/mcp`) and
 * the SQLite rows.
 *
 * Two rules make T4's hydration honest:
 * 1. a record exposes every column the schema stores for that entity, so
 *    nothing can be written that cannot be read back;
 * 2. `CompanyRecord` extends the domain `CompanyState`, so a restore is a
 *    spread, not a translation with silent gaps.
 *
 * Timestamps are optional on write (boot/first insert) but always present on
 * read, which is why the read type narrows them to `string`.
 */

import type { CompanyState, ItemId } from '../../domain/types.ts';

export interface CompanyTimestamps {
  readonly createdAtUtc?: string;
  readonly updatedAtUtc?: string;
}

/** Company row columns without the child collections. */
export type CompanyWriteInput = Omit<CompanyState, 'inventory' | 'lines'> & CompanyTimestamps;

/** A full company aggregate as written by a caller (T4 restore / boot seed). */
export type CompanyStateWrite = CompanyState & CompanyTimestamps;

/** A company as read back: domain state plus its persisted timestamps. */
export interface CompanyRecord extends CompanyState {
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

export type ReservationStatus = 'ACTIVE' | 'UNPACKED' | 'REVERTED';

/** `inventory_reservations` as read back. */
export interface InventoryReservationRecord {
  readonly reservationId: string;
  readonly companyId: string;
  readonly itemId: ItemId;
  readonly quantity: number;
  readonly lotId: string;
  readonly status: ReservationStatus;
  readonly createdAtTick: number;
}

/** Lock stock into a reservation: moves available -> reserved and inserts the row. */
export interface ReservationRequest {
  readonly reservationId: string;
  readonly lotId: string;
  readonly companyId: string;
  readonly itemId: ItemId;
  readonly quantity: number;
  readonly createdAtTick: number;
}

/**
 * Close an active reservation. `REVERTED` returns the stock to the origin
 * company; `UNPACKED` delivers it to the recipient (the buyer), which defaults
 * to the origin company when omitted.
 */
export interface ReleaseReservationRequest {
  readonly reservationId: string;
  readonly status: Exclude<ReservationStatus, 'ACTIVE'>;
  readonly recipientCompanyId?: string;
  /** Tick of the movement; recorded in `inventories.updated_at_tick` when given. */
  readonly atTick?: number;
}

/**
 * Not enough available (unreserved) stock to reserve. Carries the numbers the
 * HTTP/MCP layers need to build `ERR_INSUFFICIENT_INVENTORY`.
 */
export class InsufficientStockError extends Error {
  constructor(
    readonly companyId: string,
    readonly itemId: ItemId,
    readonly requested: number,
    readonly available: number,
  ) {
    super(
      `Insufficient available stock of ${itemId} for company "${companyId}": ` +
        `requested ${requested}, available ${available}`,
    );
    this.name = 'InsufficientStockError';
  }
}
