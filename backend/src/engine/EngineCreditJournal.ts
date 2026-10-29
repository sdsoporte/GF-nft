import {
  encodeCreditAccountRef, validateCreditLedgerOpening, validateCreditMovement,
  type CreditAccountRef, type CreditLedgerOpening, type CreditLedgerMovement,
} from '../domain/creditLedger.ts';
import type { CompanyState, SupplyContract } from '../domain/types.ts';

export interface EngineCreditJournalState {
  readonly opening: CreditLedgerOpening;
  readonly movements: readonly CreditLedgerMovement[];
}

/** Observe state, never infer payments from already closed contracts. */
export function createEngineCreditOpening(
  matchId: string, observedAtTick: number, coverage: CreditLedgerOpening['coverage'],
  companies: readonly CompanyState[], contracts: readonly SupplyContract[],
): CreditLedgerOpening {
  const balances = new Map<string, { account: CreditAccountRef; balanceCredits: number }>();
  const add = (account: CreditAccountRef, amount: number) => {
    const key = encodeCreditAccountRef(account);
    const existing = balances.get(key);
    balances.set(key, { account, balanceCredits: (existing?.balanceCredits ?? 0) + amount });
  };
  for (const company of companies) {
    add({ kind: 'AVAILABLE', companyId: company.companyId }, company.credits);
    add({ kind: 'BUYER_ESCROW', companyId: company.companyId }, 0);
    add({ kind: 'SELLER_COLLATERAL', companyId: company.companyId }, 0);
  }
  for (const contract of contracts) {
    if (contract.status !== 'ACTIVE') continue;
    add({ kind: 'BUYER_ESCROW', companyId: contract.buyerCompanyId }, contract.totalValueCredits);
    add({ kind: 'SELLER_COLLATERAL', companyId: contract.sellerCompanyId }, contract.collateralSellerCredits);
  }
  return validateCreditLedgerOpening({ matchId, observedAtTick, coverage, balances: [...balances.values()] });
}

/** Evidence only: no mutable spendable-balance mirror. Checkpoints copy this archive. */
export class EngineCreditJournal {
  private readonly opening: CreditLedgerOpening;
  private readonly movements: CreditLedgerMovement[];

  constructor(state: EngineCreditJournalState, currentTick: number) {
    this.opening = structuredClone(validateCreditLedgerOpening(state.opening));
    const keys = new Set<string>();
    this.movements = state.movements.map((input, index) => {
      const movement = validateCreditMovement(input);
      if (movement.matchId !== this.opening.matchId || movement.sequence !== index + 1 ||
          movement.tick < this.opening.observedAtTick || movement.tick > currentTick ||
          keys.has(movement.eventKey)) {
        throw new Error('[GigaForge] Inconsistent credit journal archive');
      }
      keys.add(movement.eventKey);
      return structuredClone(movement);
    });
    if (this.opening.observedAtTick > currentTick) {
      throw new Error('[GigaForge] Credit opening is ahead of the restored tick');
    }
  }

  snapshot(): EngineCreditJournalState {
    return structuredClone({ opening: this.opening, movements: this.movements });
  }

  record(
    tick: number, kind: CreditLedgerMovement['kind'], amountCredits: number,
    source: CreditAccountRef, destination: CreditAccountRef, contractId?: string, tag?: string,
  ): void {
    if (amountCredits === 0) return;
    const eventKey = JSON.stringify([kind, tick, contractId ?? null,
      encodeCreditAccountRef(source), encodeCreditAccountRef(destination), tag ?? null]);
    if (this.movements.some((movement) => movement.eventKey === eventKey)) {
      throw new Error('[GigaForge] Economic event was already recorded');
    }
    const movement = validateCreditMovement({
      matchId: this.opening.matchId, sequence: this.movements.length + 1, eventKey,
      tick, kind, amountCredits, source, destination,
      ...(contractId === undefined ? {} : { contractId }),
    });
    this.movements.push(movement);
  }
}
