/**
 * `b2b_contracts` repository (contracts and pending supply offers share the
 * table: an offer is a `PENDING` contract).
 *
 * Column set mirrors `SupplyContract` exactly; `settled_at_tick` is the only
 * nullable one and reads back as an absent property.
 */

import type { Database } from 'bun:sqlite';

import type { ContractStatus, SupplyContract } from '../../domain/types.ts';
import { filterFlag, toSupplyContract, type ContractRow } from '../rows.ts';
import { runAtomic } from '../transaction.ts';

const COLUMNS = `contract_id, seller_company_id, buyer_company_id, item_id, total_quantity,
  delivered_quantity, unit_price_credits, total_value_credits, collateral_seller_credits,
  created_at_tick, deadline_tick, penalty_per_missing_unit, status, settled_at_tick`;

const SELECT_ONE_SQL = `SELECT ${COLUMNS} FROM b2b_contracts WHERE contract_id = ?`;

/** Static SQL with filter flags: `(? = 1 OR column = ?)` per optional filter. */
const LIST_SQL = `SELECT ${COLUMNS} FROM b2b_contracts
WHERE (? = 1 OR status = ?)
  AND (? = 1 OR seller_company_id = ?)
  AND (? = 1 OR buyer_company_id = ?)
ORDER BY contract_id`;

const UPSERT_SQL = `
INSERT INTO b2b_contracts (${COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(contract_id) DO UPDATE SET
  seller_company_id = excluded.seller_company_id,
  buyer_company_id = excluded.buyer_company_id,
  item_id = excluded.item_id,
  total_quantity = excluded.total_quantity,
  delivered_quantity = excluded.delivered_quantity,
  unit_price_credits = excluded.unit_price_credits,
  total_value_credits = excluded.total_value_credits,
  collateral_seller_credits = excluded.collateral_seller_credits,
  created_at_tick = excluded.created_at_tick,
  deadline_tick = excluded.deadline_tick,
  penalty_per_missing_unit = excluded.penalty_per_missing_unit,
  status = excluded.status,
  settled_at_tick = excluded.settled_at_tick`;

export interface ContractListFilter {
  readonly status?: ContractStatus;
  readonly sellerCompanyId?: string;
  readonly buyerCompanyId?: string;
}

export class ContractRepository {
  constructor(private readonly database: Database) {}

  load(contractId: string): SupplyContract | null {
    const row = this.database.query<ContractRow>(SELECT_ONE_SQL).get(contractId);
    return row ? toSupplyContract(row) : null;
  }

  list(filter: ContractListFilter = {}): SupplyContract[] {
    const rows = this.database
      .query<ContractRow>(LIST_SQL)
      .all(
        ...filterFlag(filter.status),
        ...filterFlag(filter.sellerCompanyId),
        ...filterFlag(filter.buyerCompanyId),
      );
    return rows.map(toSupplyContract);
  }

  /** Insert or update the whole contract row (including `status`/`settled_at_tick`). */
  save(contract: SupplyContract): void {
    runAtomic(this.database, () => {
      this.database
        .query(UPSERT_SQL)
        .run(
          contract.contractId,
          contract.sellerCompanyId,
          contract.buyerCompanyId,
          contract.itemId,
          contract.totalQuantity,
          contract.deliveredQuantity,
          contract.unitPriceCredits,
          contract.totalValueCredits,
          contract.collateralSellerCredits,
          contract.createdAtTick,
          contract.deadlineTick,
          contract.penaltyPerMissingUnit,
          contract.status,
          contract.settledAtTick ?? null,
        );
    });
  }
}
