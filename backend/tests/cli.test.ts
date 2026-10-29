/**
 * CLI surface: environment validation, help text and the guarantee that the
 * bearer token is never written to stdout or stderr.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MIN_TOKEN_LENGTH,
  readFactoryConfig,
} from '../src/config.ts';
import { formatUsage, runCli } from '../src/main.ts';
import type { FactoryConfig } from '../src/config.ts';
import type { StartedServer } from '../src/main.ts';

const VALID_TOKEN = 'cli-token-0123456789abcdef0123456789';
const ENTRYPOINT = fileURLToPath(new URL('../main.ts', import.meta.url));

function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.GF_API_TOKEN;
  delete env.GF_HOST;
  delete env.GF_PORT;
  delete env.GF_SQLITE_PATH;
  return { ...env, ...overrides };
}

function capture(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (line: string) => void; stderr: (line: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

test('a valid environment yields the documented defaults', () => {
  const result = readFactoryConfig({ GF_API_TOKEN: VALID_TOKEN });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config, {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    token: VALID_TOKEN,
  });
  assert.equal(DEFAULT_HOST, '127.0.0.1');
  assert.equal(DEFAULT_PORT, 8787);
});

test('host and port overrides are honoured', () => {
  const result = readFactoryConfig({
    GF_API_TOKEN: VALID_TOKEN,
    GF_HOST: '0.0.0.0',
    GF_PORT: '9999',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.host, '0.0.0.0');
  assert.equal(result.config.port, 9999);
});

test('a missing token is a clear configuration error', () => {
  const result = readFactoryConfig({});
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /GF_API_TOKEN is required/);
});

test('a weak token is rejected without echoing its value', () => {
  const weak = 'short-token-value';
  assert.equal(weak.length < MIN_TOKEN_LENGTH, true);

  for (const token of [weak, 'a'.repeat(MIN_TOKEN_LENGTH - 1), `${'a'.repeat(40)} with space`]) {
    const result = readFactoryConfig({ GF_API_TOKEN: token });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /GF_API_TOKEN/);
    const joined = result.errors.join('\n');
    assert.equal(joined.includes(token), false, 'the configuration error echoed the token');
  }

  const exact = readFactoryConfig({ GF_API_TOKEN: 'a'.repeat(MIN_TOKEN_LENGTH) });
  assert.equal(exact.ok, true);
});

test('invalid ports are rejected', () => {
  for (const port of ['0', '65536', 'abc', '-1', '80.5']) {
    const result = readFactoryConfig({ GF_API_TOKEN: VALID_TOKEN, GF_PORT: port });
    assert.equal(result.ok, false, `expected port ${port} to be rejected`);
    if (result.ok) continue;
    assert.match(result.errors[0], /GF_PORT must be an integer between 1 and 65535/);
  }
});

test('the help text documents every server environment variable and route', () => {
  const usage = formatUsage();
  for (const expected of [
    '--help',
    'GF_API_TOKEN',
    'GF_HOST',
    'GF_PORT',
    'GF_SQLITE_PATH',
    '/health',
    '/v1/state',
    '/v1/production',
    '/v1/commands',
    'Bearer',
  ]) {
    assert.equal(usage.includes(expected), true, `help text is missing ${expected}`);
  }
});

test('--help prints usage and never starts a server', async () => {
  const { stdout, stderr, io } = capture();
  let started = false;
  const exitCode = await runCli({
    argv: ['--help'],
    env: { GF_API_TOKEN: VALID_TOKEN },
    ...io,
    startServer: async () => {
      started = true;
      throw new Error('help must not start a server');
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(started, false);
  assert.equal(stderr.length, 0);
  const help = stdout.join('\n');
  assert.equal(help.includes('GF_API_TOKEN'), true);

  // Migration 7 copy must match the shipped runtime (S4/S14): the migration
  // itself writes nothing, while the running engine settles and records.
  for (const expected of [
    'Migration 7',
    'empty tables',
    'changes no credits',
    'net of the 2% market fee',
    'COMPLETE from tick 0',
    'CUTOVER',
    'unverified',
    'companies.credits',
    'spendable balance',
  ]) {
    assert.equal(help.includes(expected), true, `help text is missing ${expected}`);
  }
  assert.equal(
    help.includes('does not settle contracts yet'),
    false,
    'help text still claims the engine does not settle contracts',
  );
});

test('a valid environment starts the server and never logs the token', async () => {
  const { stdout, stderr, io } = capture();
  const seen: FactoryConfig[] = [];
  let closed = false;

  const exitCode = await runCli({
    argv: [],
    env: { GF_API_TOKEN: VALID_TOKEN, GF_HOST: '127.0.0.1', GF_PORT: '8788' },
    ...io,
    startServer: async (config): Promise<StartedServer> => {
      seen.push(config);
      return {
        address: { host: config.host, port: config.port },
        matchId: 'match_cli_test',
        close: async () => {
          closed = true;
        },
      };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(closed, false);
  assert.deepEqual(seen, [{ host: '127.0.0.1', port: 8788, token: VALID_TOKEN }]);
  assert.equal(stderr.length, 0);

  const output = stdout.join('\n');
  assert.equal(output.includes('http://127.0.0.1:8788'), true);
  assert.equal(output.includes('match_cli_test'), true);
  assert.equal(output.includes(VALID_TOKEN), false);
  assert.equal(output.includes('Bearer'), false);
});

test('a missing token exits non-zero and names the variable', async () => {
  const { stdout, stderr, io } = capture();
  let started = false;

  const exitCode = await runCli({
    argv: [],
    env: {},
    ...io,
    startServer: async () => {
      started = true;
      throw new Error('a missing token must not start a server');
    },
  });

  assert.equal(started, false);
  assert.equal(exitCode, 1);
  assert.equal(stdout.length, 0);
  assert.equal(stderr.join('\n').includes('GF_API_TOKEN'), true);
});

test('unknown arguments exit with a usage error', async () => {
  const { stderr, io } = capture();
  const exitCode = await runCli({
    argv: ['--token=abc'],
    env: { GF_API_TOKEN: VALID_TOKEN },
    ...io,
    startServer: async () => {
      throw new Error('unknown arguments must not start a server');
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(stderr.join('\n').includes('--help'), true);
});

test('the real entrypoint prints help and exits without a token', () => {
  const help = spawnSync(process.execPath, [ENTRYPOINT, '--help'], {
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(help.status, 0);
  assert.equal(help.stdout.includes('GF_API_TOKEN'), true);
  assert.equal(help.stderr, '');

  const missing = spawnSync(process.execPath, [ENTRYPOINT], {
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.equal(missing.stderr.includes('GF_API_TOKEN'), true);
});

test('the real entrypoint never prints a rejected token', () => {
  const weakToken = 'weak-token-should-not-appear';
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    env: cleanEnv({ GF_API_TOKEN: weakToken }),
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(weakToken), false);
  assert.equal(result.stderr.includes(weakToken), false);
  assert.equal(result.stderr.includes('GF_API_TOKEN'), true);
});
