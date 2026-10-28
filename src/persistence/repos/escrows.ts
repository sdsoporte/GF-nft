/**
 * `trade_escrows` repository.
 *
 * `lot_id` references `commodity_lots`, so an escrow can never point at a lot
 * that was never packaged. Deposits/collateral are *not* modelled here: the
 * money movement and the escrow row are one unit of work (S7), which the
 * caller composes with `runAtomic`.
 */

import type { Database } from 'bun:sqlite';

import type { EscrowSettlementState, TradeEscrowRecord } from '../../domain/web3DomainModel.ts';
import { filterFlag, toTradeEscrow, type EscrowRow } from '../rows.ts';
import { runAtomic } from '../transaction.ts';

const COLUMNS = `escrow_id, lot_id, seller_company_id, buyer_company_id, agreed_price_amount,
  currency_type, seller_collateral_amount, deadline_tick, settlement_state, external_tx_hash,
  settled_at_tick`;

const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM trade_escrows WHERE escrow_id = ?`;

const LIST_SQL = `SELECT ${COLUMNS} FROM trade_escrows
WHERE (? = 1 OR settlement_state = ?)
  AND (? = 1 OR lot_id = ?)
  AND (? = 1 OR seller_company_id = ?)
ORDER BY escrow_id`;

const UPSERT_SQL = `
INSERT INTO trade_escrows (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(escrow_id) DO UPDATE SET
  lot_id = excluded.lot_id,
  seller_company_id = excluded.seller_company_id,
  buyer_company_id = excluded.buyer_company_id,
  agreed_price_amount = excluded.agreed_price_amount,
  currency_type = excluded.currency_type,
  seller_collateral_amount = excluded.seller_collateral_amount,
  deadline_tick = excluded.deadline_tick,
  settlement_state = excluded.settlement_state,
  external_tx_hash = excluded.external_tx_hash,
  settled_at_tick = excluded.settled_at_tick`;

const SET_STATE_SQL = `
UPDATE trade_escrows SET settlement_state = ?, settled_at_tick = ? WHERE escrow_id = ?`;

/** Column order for both the upsert and the plain insert. */
function escrowParams(escrow: TradeEscrowRecord): unknown[] {
  return [
    escrow.escrowId,
    escrow.lotId,
    escrow.sellerCompanyId,
    escrow.buyerCompanyId,
    escrow.agreedPriceAmount,
    escrow.currencyType,
    escrow.sellerCollateralAmount,
    escrow.deadlineTick,
    escrow.settlementState,
    escrow.externalTxHash ?? null,
    escrow.settledAtTick ?? null,
  ];
}

/**
 * Plain insert: creating an escrow must fail on a duplicate id instead of
 * overwriting an escrow that may already hold funds (S4).
 */
const INSERT_SQL = `INSERT INTO trade_escrows (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export interface EscrowListFilter {
  readonly settlementState?: EscrowSettlementState;
  readonly lotId?: string;
  readonly sellerCompanyId?: string;
}

export class EscrowRepository {
  constructor(private readonly database: Database) {}

  load(escrowId: string): TradeEscrowRecord | null {
    const row = this.database.query<EscrowRow>(SELECT_ONE_SQL).get(escrowId);
    return row ? toTradeEscrow(row) : null;
  }

  list(filter: EscrowListFilter = {}): TradeEscrowRecord[] {
    const rows = this.database
      .query<EscrowRow>(LIST_SQL)
      .all(
        ...filterFlag(filter.settlementState),
        ...filterFlag(filter.lotId),
        ...filterFlag(filter.sellerCompanyId),
      );
    return rows.map(toTradeEscrow);
  }

  save(escrow: TradeEscrowRecord): TradeEscrowRecord {
    runAtomic(this.database, () => {
      this.database.query(UPSERT_SQL).run(...escrowParams(escrow));
    });
    return escrow;
  }

  /** Insert a new escrow; a duplicate `escrow_id` is a schema rejection. */
  create(escrow: TradeEscrowRecord): TradeEscrowRecord {
    runAtomic(this.database, () => {
      this.database.query(INSERT_SQL).run(...escrowParams(escrow));
    });
    return escrow;
  }

  /**
   * Persist a settlement transition. `settledAtTick` defaults to `null`
   * (cleared); pass a tick to record when the transition happened.
   */
  setState(
    escrowId: string,
    settlementState: EscrowSettlementState,
    settledAtTick: number | null = null,
  ): void {
    runAtomic(this.database, () => {
      const result = this.database
        .query(SET_STATE_SQL)
        .run(settlementState, settledAtTick, escrowId);
      if (result.changes !== 1) {
        throw new Error(`Trade escrow "${escrowId}" not found`);
      }
    });
  }
}
