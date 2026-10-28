/**
 * Boot wiring for SQLite persistence (S3/S6): parent directory creation, open,
 * migrate, store injection into the match, and the documented environment
 * variable in the server help text.
 *
 * Nothing here listens on a port: the server handle is created but never
 * started, so the tests observe the wiring rather than the transport.
 */

import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { FactoryMatch, DEFAULT_TICK_INTERVAL_MS } from '../../backend/src/match.ts';
import { SQLITE_PATH_ENV_VAR } from '../../backend/src/config.ts';
import { createFactoryServer } from '../../backend/src/http.ts';
import { formatUsage, openMatchPersistence, runCli } from '../../backend/src/main.ts';
import type { StartedServer } from '../../backend/src/main.ts';
import { getCurrentVersion, MIGRATIONS } from '../../src/persistence/migrations.ts';
import { MATCH_ID, productionPayload, withTempDirectory } from './queue-fixtures.ts';

const TEST_TOKEN = 'test-token-0123456789abcdef0123456789';

test('boot creates the missing parent directory, migrates and injects a working store', () => {
  withTempDirectory((directory) => {
    const path = join(directory, 'nested', 'deeper', 'factory.db');
    const persistence = openMatchPersistence(path);
    try {
      assert.equal(getCurrentVersion(persistence.store.database), MIGRATIONS.length);

      const match = new FactoryMatch({ store: persistence.store, matchId: MATCH_ID });
      const decision = match.requestProduction(productionPayload());
      assert.equal(decision.kind, 'queued');
      assert.equal(persistence.store.repositories.ackLedger.count(MATCH_ID), 1);
    } finally {
      persistence.close();
    }

    assert.deepEqual(readdirSync(join(directory, 'nested', 'deeper')).includes('factory.db'), true);
  });
});

test('boot adopts the persisted match on the second start of the same path', () => {
  withTempDirectory((directory) => {
    const path = join(directory, 'state', 'factory.db');
    const first = openMatchPersistence(path);
    const matchId = new FactoryMatch({ store: first.store }).matchId;
    first.close();

    const second = openMatchPersistence(path);
    try {
      const reopened = new FactoryMatch({ store: second.store });
      assert.equal(reopened.matchId, matchId);
      assert.equal(second.store.repositories.matches.load(matchId)?.matchId, matchId);
    } finally {
      second.close();
    }
  });
});

test('boot fails loudly when the configured path cannot be a database file', () => {
  withTempDirectory((directory) => {
    const blocker = join(directory, 'blocker');
    writeFileSync(blocker, 'not a directory');
    assert.throws(() => openMatchPersistence(join(blocker, 'factory.db')));
  });
});

test('the server passes the injected store to the match it creates', () => {
  withTempDirectory((directory) => {
    mkdirSync(join(directory, 'state'), { recursive: true });
    const persistence = openMatchPersistence(join(directory, 'state', 'factory.db'));
    try {
      const handle = createFactoryServer({
        token: TEST_TOKEN,
        store: persistence.store,
        matchId: MATCH_ID,
        tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
      });

      assert.equal(handle.match.matchId, MATCH_ID);
      assert.equal(handle.match.requestProduction(productionPayload()).kind, 'queued');
      assert.equal(persistence.store.repositories.ackLedger.count(MATCH_ID), 1);
      assert.equal(persistence.store.repositories.queue.countPending(MATCH_ID), 1);
    } finally {
      persistence.close();
    }
  });
});

test('the help text documents the SQLite path variable and the in-memory default', () => {
  const usage = formatUsage();
  assert.equal(SQLITE_PATH_ENV_VAR, 'GF_SQLITE_PATH');
  assert.equal(usage.includes(SQLITE_PATH_ENV_VAR), true, 'help text is missing GF_SQLITE_PATH');
  assert.match(usage, /in memory/i);
});

test('the CLI forwards a configured sqlite path to the server starter', async () => {
  const seen: { sqlitePath?: string }[] = [];
  const exitCode = await runCli({
    argv: [],
    env: { GF_API_TOKEN: TEST_TOKEN, GF_SQLITE_PATH: '/tmp/gf-cli-test/factory.db' },
    stdout: () => {},
    stderr: () => {},
    startServer: async (config): Promise<StartedServer> => {
      seen.push(config);
      return {
        address: { host: config.host, port: config.port },
        matchId: 'match_cli_test',
        close: async () => {},
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(seen, [
    { host: '127.0.0.1', port: 8787, token: TEST_TOKEN, sqlitePath: '/tmp/gf-cli-test/factory.db' },
  ]);
});

test('the CLI forwards the unchanged config shape when no sqlite path is set', async () => {
  const seen: { sqlitePath?: string }[] = [];
  await runCli({
    argv: [],
    env: { GF_API_TOKEN: TEST_TOKEN },
    stdout: () => {},
    stderr: () => {},
    startServer: async (config): Promise<StartedServer> => {
      seen.push(config);
      return {
        address: { host: config.host, port: config.port },
        matchId: 'match_cli_test',
        close: async () => {},
      };
    },
  });

  assert.deepEqual(seen, [{ host: '127.0.0.1', port: 8787, token: TEST_TOKEN }]);
  assert.equal('sqlitePath' in seen[0], false);
});
