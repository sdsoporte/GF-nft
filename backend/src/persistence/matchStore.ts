/**
 * Match-level durable units of work (S3/S6/S8, risk item 4).
 *
 * `MatchStore` is the single seam between `FactoryMatch` and SQLite. It owns
 * three units of work and nothing else:
 *
 * 1. `adoptOrCreate` — boot: adopt the persisted match row (identity, seed,
 *    interval, counters) or create one, and hand back the ledger/cursor rows a
 *    restart replays from.
 * 2. `commitCommand` — one accepted command: match metadata, queue mirror,
 *    permanent idempotency key and the acknowledgement ledger row commit
 *    together.
 * 3. `commitExecutions` — one tick of progress: the match metadata (tick,
 *    history cursor), the new execution-history rows and the queue rows they
 *    clear commit together.
 *
 * Consistency approach (risk item 4). Bun is single-threaded and every unit is
 * synchronous, so the danger is not a concurrent reader: it is a half-committed
 * unit. Each method runs *all* its repository writes inside one `runAtomic`
 * transaction, and the caller applies the same change to memory only after the
 * transaction returns. The database is therefore the floor: memory never holds a
 * command, an acknowledgement or a cursor advance the database refused.
 *
 * Ordering inside `commitCommand` is deliberate. The command body is handed to
 * the engine through `apply`, which runs *last*, immediately before COMMIT, so
 * the durable rows exist before the in-memory engine observes the command. If
 * `apply` refuses (the engine's own idempotency guard) the unit throws
 * `CommandNotAccepted` and every row written so far rolls back — the refusal
 * cannot leave a queue row behind.
 *
 * `apply` is a thunk rather than an imported engine because the persistence
 * layer must not depend on `src/engine`; the match passes one closure.
 */

import { randomBytes } from 'node:crypto';

import type { Database } from 'bun:sqlite';

import {
  createRepositories,
  type AckLedgerRecord,
  type AckLedgerWrite,
  type CommandResultRecord,
  type CommandResultWrite,
  type CreditJournalMovementWrite,
  type CreditJournalOpeningWrite,
  type MatchMetadataRecord,
  type MatchMetadataWrite,
  type ProcessedIdempotencyWrite,
  type QueuedCommandRecord,
  type QueuedCommandWrite,
  type Repositories,
} from './repos/index.ts';
import { runAtomic } from './transaction.ts';

export { AckLedgerCapacityError } from './repos/index.ts';

/** Same identifier format as a store-free match; two modules by layering. */
function createMatchId(): string {
  return `match_${randomBytes(8).toString('hex')}`;
}

/** The engine refused a command the store was asked to admit. */
export class CommandNotAccepted extends Error {
  constructor(readonly commandId: string) {
    super(`The engine refused command "${commandId}"; no durable row was kept for it`);
    this.name = 'CommandNotAccepted';
  }
}

export interface AdoptMatchInput {
  readonly seed: number;
  readonly tickIntervalMs: number;
  /** Explicit match id; absent adopts the most recently updated match. */
  readonly matchId?: string;
}

/** What a booting match needs to restore its own bookkeeping. */
export interface AdoptedMatch {
  readonly metadata: MatchMetadataRecord;
  /** False when this call inserted the row (a genuinely new match). */
  readonly adopted: boolean;
  readonly acknowledged: readonly AckLedgerRecord[];
  readonly pending: readonly QueuedCommandRecord[];
  readonly results: readonly CommandResultRecord[];
}

export interface CommitCommandInput {
  /** Full match metadata snapshot to persist with this command. */
  readonly metadata: MatchMetadataWrite;
  /** Queue mirror of the command. */
  readonly command: QueuedCommandWrite;
  /** Permanent dedupe key for the command. */
  readonly processed: ProcessedIdempotencyWrite;
  /** HTTP-only acknowledgement; non-HTTP admissions do not consume its capacity. */
  readonly acknowledgement?: AckLedgerWrite;
  /** Last step before COMMIT: hand the command to the engine. */
  readonly apply: () => boolean;
}

export interface CommitExecutionsInput {
  /** Full match metadata snapshot to persist with this tick. */
  readonly metadata: MatchMetadataWrite;
  /** Execution-history rows to append, in `historyIndex` order. */
  readonly results: readonly CommandResultWrite[];
  /** Queue rows that reached the history and must be cleared. */
  readonly completedCommandIds: readonly string[];
  /**
   * Optional: create this match's immutable credit-journal opening as part of
   * the same unit of work (S4/S14). Omitted keeps the previous behavior. A new
   * match records a COMPLETE opening; an upgraded legacy match records CUTOVER
   * with the balances observed at its tick.
   */
  readonly opening?: CreditJournalOpeningWrite;
  /**
   * Optional: append these journal movements inside the same tick transaction,
   * so a rejected movement removes the tick metadata and history written before
   * it. Omitted keeps the previous behavior. Requires an opening (the one in
   * `opening` or an earlier committed one).
   */
  readonly movements?: readonly CreditJournalMovementWrite[];
}

function assertSameMatch(expected: string, actual: string, label: string): void {
  if (expected !== actual) {
    throw new Error(
      `MatchStore received a ${label} for match "${actual}" inside the unit of work of "${expected}"`,
    );
  }
}

export class MatchStore {
  readonly database: Database;
  readonly repositories: Repositories;

  constructor(database: Database, repositories?: Repositories) {
    this.database = database;
    this.repositories = repositories ?? createRepositories(database);
  }

  /**
   * Adopt the persisted match or create it. With no explicit `matchId`, the
   * most recently updated match is adopted, which is what "restart the backend
   * and continue the same match" means for a single-match server.
   *
   * Deliberately stateless: the store holds no "current match", so one store
   * can serve several matches and every unit of work takes its match id from
   * the rows it is about to write. The schema's foreign keys are then the only
   * binding that matters.
   */
  adoptOrCreate(input: AdoptMatchInput): AdoptedMatch {
    const requestedMatchId =
      typeof input.matchId === 'string' && input.matchId.trim().length > 0
        ? input.matchId.trim()
        : null;

    const existing =
      requestedMatchId === null
        ? this.repositories.matches.loadLatest()
        : this.repositories.matches.load(requestedMatchId);

    let metadata: MatchMetadataRecord;
    if (existing) {
      metadata = existing;
    } else {
      const matchId = requestedMatchId ?? createMatchId();
      this.repositories.matches.save({
        matchId,
        seed: input.seed,
        currentTick: 0,
        sequenceCounter: 0,
        historyCursor: 0,
        tickIntervalMs: input.tickIntervalMs,
      });
      const inserted = this.repositories.matches.load(matchId);
      if (!inserted) {
        throw new Error(`MatchStore failed to persist the match row for "${matchId}"`);
      }
      metadata = inserted;
    }

    return {
      metadata,
      adopted: existing !== null,
      acknowledged: this.repositories.ackLedger.list(metadata.matchId),
      pending: this.repositories.queue.listPending(metadata.matchId),
      results: this.repositories.commandResults.list(metadata.matchId),
    };
  }

  /**
   * Persist one accepted command as a single unit of work, then let the engine
   * admit it. Throws `CommandNotAccepted` (after rolling back every row) when
   * the engine refuses.
   */
  commitCommand(input: CommitCommandInput): void {
    const matchId = input.metadata.matchId;
    assertSameMatch(matchId, input.command.matchId, 'queue row');
    assertSameMatch(matchId, input.processed.matchId, 'processed key');
    if (input.acknowledgement) {
      assertSameMatch(matchId, input.acknowledgement.matchId, 'acknowledgement');
    }

    runAtomic(this.database, () => {
      this.repositories.matches.save(input.metadata);
      this.repositories.queue.enqueue(input.command);
      this.repositories.queue.markProcessed(input.processed);
      if (input.acknowledgement) this.repositories.ackLedger.record(input.acknowledgement);
      if (!input.apply()) {
        throw new CommandNotAccepted(input.command.commandId);
      }
    });
  }

  /**
   * Persist one tick of progress: metadata, execution history and the queue
   * rows the history supersedes. A tick with no executed command still writes
   * the metadata, so `current_tick` and `history_cursor` never lag behind.
   *
   * When the caller supplies `opening`/`movements` the credit journal is written
   * in the same transaction (S4/S14): the journal never records a tick the
   * metadata refused, and a rejected movement rolls the metadata and history
   * back with it. `companies.credits` is not touched here.
   */
  commitExecutions(input: CommitExecutionsInput): void {
    const matchId = input.metadata.matchId;
    for (const result of input.results) {
      assertSameMatch(matchId, result.matchId, 'command result');
    }
    if (input.opening) {
      assertSameMatch(matchId, input.opening.matchId, 'journal opening');
    }
    if (input.movements) {
      for (const movement of input.movements) {
        assertSameMatch(matchId, movement.matchId, 'journal movement');
      }
    }

    runAtomic(this.database, () => {
      this.repositories.matches.save(input.metadata);
      if (input.opening) this.repositories.creditJournal.createOpening(input.opening);
      if (input.movements) {
        this.repositories.creditJournal.append(matchId, input.movements);
      }
      this.repositories.commandResults.appendMany(input.results);
      this.repositories.queue.remove(matchId, input.completedCommandIds);
    });
  }
}

export function createMatchStore(database: Database, repositories?: Repositories): MatchStore {
  return new MatchStore(database, repositories);
}
