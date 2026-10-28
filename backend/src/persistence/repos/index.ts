/**
 * Repository layer over one `bun:sqlite` database handle (S2/S4/S10).
 *
 * `Repositories` is the single injection point T3/T4/T5 need: give it the
 * handle opened by `openDatabase` + migrated by `migrate`, and every entity in
 * issue #8 is available. `saveCompanyState`/`loadCompanyState` are the
 * aggregate pair T4 hydrates from, and they are the one write path that spans
 * three tables atomically (companies + inventories + production_lines).
 *
 * Every write method is atomic on its own and composable inside `runAtomic`
 * (see `src/persistence/transaction.ts`), so a settlement spanning lots,
 * escrows, reservations and balances commits or rolls back as one unit.
 */

import type { Database } from 'bun:sqlite';

import { runAtomic } from '../transaction.ts';
import { AckLedgerRepository } from './ackLedger.ts';
import { CommandQueueRepository } from './commandQueue.ts';
import { CommandResultRepository } from './commandResults.ts';
import { CompanyRepository } from './companies.ts';
import { ContractRepository } from './contracts.ts';
import { EscrowRepository } from './escrows.ts';
import { GrantRepository } from './grants.ts';
import { InventoryRepository } from './inventory.ts';
import { LotRepository } from './lots.ts';
import { MatchMetadataRepository } from './matches.ts';
import { ProductionLineRepository } from './lines.ts';
import { ReservationRepository } from './reservations.ts';
import { SettlementCounterRepository } from './settlementCounters.ts';
import type { CompanyRecord, CompanyStateWrite } from './types.ts';

export * from './types.ts';
export {
  AckLedgerCapacityError,
  AckLedgerRepository,
} from './ackLedger.ts';
export { CommandQueueRepository } from './commandQueue.ts';
export { CommandResultRepository } from './commandResults.ts';
export { CompanyRepository } from './companies.ts';
export { ContractRepository, type ContractListFilter } from './contracts.ts';
export { EscrowRepository, type EscrowListFilter } from './escrows.ts';
export { GrantRepository, type AuditListFilter, type GrantListFilter } from './grants.ts';
export { InventoryRepository } from './inventory.ts';
export { LotRepository, type LotListFilter } from './lots.ts';
export { MatchMetadataRepository } from './matches.ts';
export { ProductionLineRepository } from './lines.ts';
export { ReservationRepository, type ReservationListFilter } from './reservations.ts';
export {
  SETTLEMENT_SEQUENCES,
  SettlementCounterRepository,
  type SettlementSequence,
} from './settlementCounters.ts';

export class Repositories {
  readonly database: Database;
  readonly companies: CompanyRepository;
  readonly inventory: InventoryRepository;
  readonly lines: ProductionLineRepository;
  readonly contracts: ContractRepository;
  readonly lots: LotRepository;
  readonly escrows: EscrowRepository;
  readonly reservations: ReservationRepository;
  /** Durable id sequences and per-account anti-replay nonces (T5a). */
  readonly settlementCounters: SettlementCounterRepository;
  readonly grants: GrantRepository;
  /** Per-match metadata plus the queue/idempotency/ack/history rows (T3). */
  readonly matches: MatchMetadataRepository;
  readonly queue: CommandQueueRepository;
  readonly ackLedger: AckLedgerRepository;
  readonly commandResults: CommandResultRepository;

  constructor(database: Database) {
    this.database = database;
    this.companies = new CompanyRepository(database);
    this.inventory = new InventoryRepository(database);
    this.lines = new ProductionLineRepository(database);
    this.contracts = new ContractRepository(database);
    this.lots = new LotRepository(database);
    this.escrows = new EscrowRepository(database);
    this.reservations = new ReservationRepository(database);
    this.settlementCounters = new SettlementCounterRepository(database);
    this.grants = new GrantRepository(database);
    this.matches = new MatchMetadataRepository(database);
    this.queue = new CommandQueueRepository(database);
    this.ackLedger = new AckLedgerRepository(database);
    this.commandResults = new CommandResultRepository(database);
  }

  /**
   * Store one company with its inventory and production lines atomically. A
   * failure anywhere (for example a bad line) leaves all three tables as they
   * were, which is the aggregate case the S7 rollback test pins.
   */
  saveCompanyState(record: CompanyStateWrite): void {
    runAtomic(this.database, () => {
      this.companies.save(record);
      this.inventory.save(record.companyId, record.inventory);
      this.lines.saveMany(record.companyId, record.lines);
    });
  }

  /** Read one company back as domain state (row columns + inventory + lines). */
  loadCompanyState(companyId: string): CompanyRecord | null {
    return this.companies.load(companyId);
  }
}

export function createRepositories(database: Database): Repositories {
  return new Repositories(database);
}
