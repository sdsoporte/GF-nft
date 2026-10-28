/**
 * Shared fixtures for the command-queue / idempotency / ack-ledger tests (T3).
 *
 * Not a test file on purpose (`bun test` only collects `*.test.ts`). Every
 * helper opens its own database in its own temporary directory, so no test can
 * observe another test's rows and nothing is left behind on disk.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Database } from 'bun:sqlite';

import { closeDatabase, openDatabase } from '../../src/persistence/database.ts';
import { createMatchStore, type MatchStore } from '../../src/persistence/matchStore.ts';
import { migrate } from '../../src/persistence/migrations.ts';
import type {
  MatchMetadataWrite,
  QueuedCommandWrite,
} from '../../src/persistence/repos/index.ts';

export const MATCH_ID = 'match_queue_test01';
export const SERVER_COMPANY = 'comp_metal_01';
export const SERVER_LINE = 'comp_metal_01_line_1';
export const FIXED_TIME = '2026-01-01T00:00:00.000Z';
export const LATER_TIME = '2026-01-01T00:05:00.000Z';

/** Run `work` against a fresh temporary directory, removed afterwards. */
export function withTempDirectory<T>(work: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'gf-queue-'));
  try {
    return work(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

/** Open and migrate the database at `path`, returning it with a match store. */
export function openPersistedStore(path: string): { database: Database; store: MatchStore } {
  const database = openDatabase(path);
  migrate(database);
  return { database, store: createMatchStore(database) };
}

/** Run `work` against one migrated temporary database. */
export function withMatchStore(
  work: (store: MatchStore, database: Database, path: string) => void,
): void {
  withTempDirectory((directory) => {
    const path = join(directory, 'factory.db');
    const { database, store } = openPersistedStore(path);
    try {
      work(store, database, path);
    } finally {
      closeDatabase(database);
    }
  });
}

export function sampleMetadata(overrides: Partial<MatchMetadataWrite> = {}): MatchMetadataWrite {
  return {
    matchId: MATCH_ID,
    seed: 42107,
    currentTick: 0,
    sequenceCounter: 0,
    historyCursor: 0,
    tickIntervalMs: 1000,
    createdAtUtc: FIXED_TIME,
    updatedAtUtc: FIXED_TIME,
    ...overrides,
  };
}

export function sampleQueuedCommand(
  overrides: Partial<QueuedCommandWrite> = {},
): QueuedCommandWrite {
  return {
    commandId: 'cmd_queue_1',
    matchId: MATCH_ID,
    companyId: SERVER_COMPANY,
    sequenceNumber: 1,
    scheduledTick: 1,
    idempotencyKey: `http:${MATCH_ID}:request-1`,
    commandType: 'SET_PRODUCTION_TARGET',
    payloadJson: JSON.stringify({
      type: 'SET_PRODUCTION_TARGET',
      commandId: 'cmd_queue_1',
      lineId: SERVER_LINE,
      recipeId: 'R1',
      targetBatches: 1,
    }),
    createdAtUtc: FIXED_TIME,
    ...overrides,
  };
}

export function sampleProcessedKey(
  overrides: Partial<{ matchId: string; idempotencyKey: string; commandId: string; processedAtUtc: string }> = {},
): { matchId: string; idempotencyKey: string; commandId: string; processedAtUtc: string } {
  return {
    matchId: MATCH_ID,
    idempotencyKey: `http:${MATCH_ID}:request-1`,
    commandId: 'cmd_queue_1',
    processedAtUtc: FIXED_TIME,
    ...overrides,
  };
}

export function sampleAcknowledgement(
  overrides: Partial<{
    matchId: string;
    requestId: string;
    fingerprint: string;
    commandId: string;
    acknowledgedAtUtc: string;
  }> = {},
): {
  matchId: string;
  requestId: string;
  fingerprint: string;
  commandId: string;
  acknowledgedAtUtc: string;
} {
  return {
    matchId: MATCH_ID,
    requestId: 'request-1',
    fingerprint: `${SERVER_LINE}\nR1`,
    commandId: 'cmd_queue_1',
    acknowledgedAtUtc: FIXED_TIME,
    ...overrides,
  };
}

/** `POST /v1/production` payload used by the match-level tests. */
export function productionPayload(overrides: Partial<{ requestId: string; lineId: string; recipeId: string }> = {}): {
  requestId: string;
  lineId: string;
  recipeId: string;
} {
  return {
    requestId: 'request-1',
    lineId: SERVER_LINE,
    recipeId: 'R1',
    ...overrides,
  };
}
