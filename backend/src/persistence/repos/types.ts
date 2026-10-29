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
import type {
  CreditLedgerMovement,
  CreditLedgerOpening,
} from '../../domain/creditLedger.ts';

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

// --- match metadata, command queue, idempotency, ack ledger, history --------
// (S3) These rows are what a restart reads back: match-level counters, the
// pending command mirrors, the permanent idempotency keys, the HTTP
// acknowledgement ledger and the append-only execution history.

/**
 * `matches` as read back. Every column is exposed because these five numbers
 * are exactly what boot adoption restores; nothing is stored that cannot be
 * read back.
 */
export interface MatchMetadataRecord {
  readonly matchId: string;
  readonly seed: number;
  readonly currentTick: number;
  readonly sequenceCounter: number;
  readonly historyCursor: number;
  readonly tickIntervalMs: number;
  readonly createdAtUtc: string;
  readonly updatedAtUtc: string;
}

/** `matches` write input: timestamps are optional (boot fills them). */
export interface MatchMetadataWrite {
  readonly matchId: string;
  readonly seed: number;
  readonly currentTick: number;
  readonly sequenceCounter: number;
  readonly historyCursor: number;
  readonly tickIntervalMs: number;
  readonly createdAtUtc?: string;
  readonly updatedAtUtc?: string;
}

/** One pending command mirror (`match_command_queue`) as read back. */
export interface QueuedCommandRecord {
  readonly commandId: string;
  readonly matchId: string;
  readonly companyId: string;
  readonly sequenceNumber: number;
  readonly scheduledTick: number;
  readonly idempotencyKey: string;
  readonly commandType: string;
  readonly payloadJson: string;
  readonly createdAtUtc: string;
}

/** Queue write input; the polymorphic command body travels as JSON. */
export type QueuedCommandWrite = Omit<QueuedCommandRecord, 'createdAtUtc'> & {
  readonly createdAtUtc?: string;
};

/** One permanent dedupe key (`match_processed_idempotency_keys`). */
export interface ProcessedIdempotencyRecord {
  readonly matchId: string;
  readonly idempotencyKey: string;
  readonly commandId: string;
  readonly processedAtUtc: string;
}

export type ProcessedIdempotencyWrite = Omit<ProcessedIdempotencyRecord, 'processedAtUtc'> & {
  readonly processedAtUtc?: string;
};

/** One acknowledgement row (`match_ack_ledger`). */
export interface AckLedgerRecord {
  readonly matchId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly commandId: string;
  readonly acknowledgedAtUtc: string;
}

/**
 * Ack-ledger write input. `capacity` is the match-level retention limit
 * (`MAX_ACKNOWLEDGED_REQUESTS`); a full ledger rejects the write instead of
 * evicting a durable acknowledgement (see `AckLedgerRepository`).
 */
export interface AckLedgerWrite {
  readonly matchId: string;
  readonly requestId: string;
  readonly fingerprint: string;
  readonly commandId: string;
  readonly acknowledgedAtUtc?: string;
  readonly capacity: number;
}

/** One execution-history row (`match_command_results`) as read back. */
export interface CommandResultRecord {
  /** Legacy rows are deliberately unowned; never infer a tenant at restore. */
  readonly companyId?: string;
  readonly matchId: string;
  readonly historyIndex: number;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly executedAtTick: number;
  readonly success: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export type CommandResultWrite = Omit<CommandResultRecord, 'matchId'> & {
  readonly matchId: string;
};

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

// --- credit journal (S4/S14) ------------------------------------------------
// The append-only monetary journal. Records are the domain types plus the
// persistence timestamp, exactly like every other row type here: nothing is
// stored that cannot be read back. `companies.credits` stays the authoritative
// spendable balance; the journal is evidence, not a second balance store.

/** Opening write input; `openedAtUtc` is optional (boot/operator fills it). */
export interface CreditJournalOpeningWrite extends CreditLedgerOpening {
  readonly openedAtUtc?: string;
}

/** An immutable opening as read back. */
export interface CreditJournalOpeningRecord extends CreditLedgerOpening {
  readonly openedAtUtc: string;
}

/** Movement write input; `recordedAtUtc` is optional (the store fills it). */
export interface CreditJournalMovementWrite extends CreditLedgerMovement {
  readonly recordedAtUtc?: string;
}

/** One append-only movement as read back. */
export interface CreditJournalMovementRecord extends CreditLedgerMovement {
  readonly recordedAtUtc: string;
}
