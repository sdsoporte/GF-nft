/**
 * Recovery oracle for the S5/S9 mid-match restart tests (assumption A4).
 *
 * The issue demands a *full state* comparison, because `calculateStateHash()`
 * is partial: it hashes tick, the global-project delivered count and a handful
 * of company scalars, so it silently ignores production lines, `activeBatch`
 * progress, contracts, the command queue, the idempotency keys, the execution
 * history and every match-level counter. Two different mid-game states can
 * share one hash, which is exactly what S9 forbids as the sole oracle.
 *
 * This module therefore builds a snapshot-grade, deterministic, canonical view
 * of everything a restart must reconstruct:
 *
 * - engine: tick, global project, every company (scalars, inventory, lines with
 *   all seven `activeBatch` columns, maintenance counters, turbines, delivered
 *   parts), every contract (escrow amounts, status, deadline, `settledAtTick`),
 *   the pending command queue, the processed idempotency keys, the execution
 *   history and the queue sequence counter;
 * - match: identity, tick interval, acknowledged request count, the public
 *   `/v1/state` projection and the command-status map;
 * - persisted: the `matches` counters plus the row counts of the queue,
 *   processed-key, result and ack tables.
 *
 * `calculateStateHash()` is included as one *secondary* field, never as the
 * only signal.
 *
 * Canonicalisation (why the comparison is a byte comparison): object keys are
 * sorted recursively and every number must be a safe integer. Row order from
 * SQLite (`ORDER BY company_id` puts `comp_manuf_*` before `comp_metal_*`)
 * therefore cannot make two identical states look different, while a float or
 * an out-of-order array (lines, history, contracts) still fails loudly.
 *
 * Excluded on purpose — repo-only audit timestamps:
 * - `companies.created_at_utc` / `companies.updated_at_utc`,
 * - `matches.created_at_utc` / `matches.updated_at_utc`,
 * - `inventories.updated_at_tick`,
 * - `match_command_queue.created_at_utc`, `match_processed_idempotency_keys
 *   .processed_at_utc`, `match_ack_ledger.acknowledged_at_utc`.
 *
 * They record *when* a row was written, not *what the simulation is doing*: a
 * hydrated match rewrites `updated_at_utc` with the restart time, so comparing
 * them would fail for a perfectly exact restore. They are persisted-and-
 * restored (the row counts above prove the rows exist) but they are not part of
 * the simulation state, and this file is where that choice is recorded.
 */

import type { FactoryMatch } from '../../backend/src/match.ts';
import type { CompanyState } from '../../src/domain/types.ts';
import type { MatchStore } from '../../src/persistence/matchStore.ts';

/** Anything the canonicaliser accepts: JSON plus safe integers only. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * Sort object keys recursively and reject anything the wire format cannot
 * represent exactly (non-safe-integer numbers, `undefined`, functions). The
 * path in the error names the offending field.
 */
export function canonicalize(value: unknown, path = '$'): CanonicalValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Recovery oracle found a non-integer number at ${path}: ${value}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      if (entry === undefined) continue; // JSON drops absent optional fields too
      sorted[key] = canonicalize(entry, `${path}.${key}`);
    }
    return sorted;
  }
  throw new Error(`Recovery oracle cannot canonicalise ${typeof value} at ${path}`);
}

/** Canonical JSON text: the byte string the S5/S9 tests compare. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Sorted-by-id companies with their lines sorted by line id. */
function canonicalCompanies(companies: Record<string, CompanyState>): CompanyState[] {
  return Object.keys(companies)
    .sort()
    .map((companyId) => {
      const company = companies[companyId] as CompanyState;
      return {
        ...company,
        lines: [...company.lines].sort((left, right) => left.lineId.localeCompare(right.lineId)),
      };
    });
}

export interface RecoveryOracleOptions {
  /**
   * Replace every command id by its first-appearance index (`cmd#1`, `cmd#2`…).
   *
   * Command ids are random per match (`randomBytes` in the match layer), so two
   * independent databases driven by the same script carry different ids for the
   * same command. Relabelling keeps cross-database comparisons exact (the states
   * must be isomorphic) without weakening them: order, counts, sequence numbers,
   * ticks and every other field are still compared, and the raw ids stay compared
   * whenever both sides share one database lineage — which is exactly the S5
   * before/after case.
   */
  readonly relabelCommandIds?: boolean;
}

/** Compare-oracle shape after canonicalisation. */
export type RecoveryOracle = CanonicalValue;

/** Command ids in a stable order: history, then pending queue, then statuses. */
function collectCommandIds(oracle: CanonicalValue): string[] {
  const ids: string[] = [];
  const add = (value: CanonicalValue | undefined): void => {
    if (typeof value === 'string' && !ids.includes(value)) ids.push(value);
  };
  const engine = (oracle as Record<string, CanonicalValue>).engine as Record<string, CanonicalValue>;
  for (const result of engine.executionHistory as CanonicalValue[]) {
    add((result as Record<string, CanonicalValue>).commandId);
  }
  const queue = engine.queue as Record<string, CanonicalValue>;
  for (const command of queue.pending as CanonicalValue[]) {
    add((command as Record<string, CanonicalValue>).commandId);
  }
  const match = (oracle as Record<string, CanonicalValue>).match as Record<string, CanonicalValue>;
  for (const status of match.commandStatuses as CanonicalValue[]) {
    add((status as Record<string, CanonicalValue>).commandId);
  }
  return ids;
}

function replaceStrings(
  value: CanonicalValue,
  mapping: ReadonlyMap<string, string>,
): CanonicalValue {
  if (typeof value === 'string') return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map((entry) => replaceStrings(entry, mapping));
  if (value === null) return null;
  const replaced: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(value)) {
    replaced[key] = replaceStrings((value as Record<string, CanonicalValue>)[key], mapping);
  }
  return replaced;
}

function relabelCommandIds(oracle: CanonicalValue): CanonicalValue {
  const mapping = new Map(
    collectCommandIds(oracle).map((commandId, index) => [commandId, `cmd#${index + 1}`] as const),
  );
  return replaceStrings(oracle, mapping);
}

/**
 * Build the comparable state of one live match.
 *
 * `observedCommandIds` narrows the command-status map to the commands the test
 * itself drove through the match API: the contract-seam commands (see the test)
 * are admitted straight through the store, so the match knows their status only
 * after a restore, and comparing them would report a harness asymmetry instead
 * of a recovery defect. Their effects are covered by the engine-side oracle
 * (contracts, execution history, processed keys).
 */
export function buildRecoveryOracle(
  match: FactoryMatch,
  store: MatchStore,
  observedCommandIds: readonly string[],
  options: RecoveryOracleOptions = {},
): RecoveryOracle {
  const engine = match.engine;
  const snapshot = engine.createSnapshot();
  const queue = engine.getCommandQueue();
  const metadata = store.repositories.matches.load(match.matchId);

  // Submission order (the script's own order), not sorted by id: ids are random
  // per match, so sorting by them would reorder this array differently in every
  // run and break cross-database comparison for no informational gain.
  const commandStatuses = observedCommandIds.map((commandId) => ({
    commandId,
    status: match.getCommandStatus(commandId) ?? null,
  }));

  const canonical = canonicalize({
    match: {
      matchId: match.matchId,
      tickIntervalMs: match.tickIntervalMs,
      // Deliberately NOT `getAcknowledgedRequestCount()`: the harness admits its
      // contract commands through the store seam, so their acknowledgement rows
      // exist in the database but only enter the live ledger on a restore. That
      // asymmetry is a property of the harness, not of recovery. The durable
      // truth is compared instead (`persisted.ackRows`) and the S5 test asserts
      // separately that a hydrated match folds every row back into its ledger.
      statePayload: match.getStatePayload(),
      commandStatuses,
    },
    persisted:
      metadata === null
        ? null
        : {
            seed: metadata.seed,
            currentTick: metadata.currentTick,
            sequenceCounter: metadata.sequenceCounter,
            historyCursor: metadata.historyCursor,
            tickIntervalMs: metadata.tickIntervalMs,
            pendingRows: store.repositories.queue.countPending(match.matchId),
            processedKeyRows: store.repositories.queue.countProcessed(match.matchId),
            resultRows: store.repositories.commandResults.count(match.matchId),
            ackRows: store.repositories.ackLedger.count(match.matchId),
          },
    engine: {
      tick: engine.getCurrentTick(),
      // Secondary signal only (QA L12): the hash is partial and never the sole
      // oracle for this comparison.
      stateHash: engine.calculateStateHash(),
      // Never advanced by tick logic today; compared so a future tick rule that
      // starts consuming the PRNG cannot break exact recovery unnoticed.
      prngState: engine.getPrngState(),
      globalProject: engine.getGlobalProject(),
      companies: canonicalCompanies(snapshot.companies),
      contracts: Object.keys(snapshot.contracts)
        .sort()
        .map((contractId) => snapshot.contracts[contractId]),
      queue: {
        sequenceCounter: queue.getSequenceCounter(),
        pending: queue.listPending(),
        processedIdempotencyKeys: [...queue.listProcessedIdempotencyKeys()].sort(),
      },
      executionHistory: engine.getExecutionHistory(),
    },
  });

  return options.relabelCommandIds === true ? relabelCommandIds(canonical) : canonical;
}
