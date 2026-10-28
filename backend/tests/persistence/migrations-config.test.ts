/**
 * `GF_SQLITE_PATH` configuration parsing: unset keeps SQLite persistence
 * disabled (backward compatible), a set value is trimmed and validated.
 * Parent directory creation belongs to boot, not to configuration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readFactoryConfig } from '../../src/config.ts';

const VALID_TOKEN = 'a'.repeat(40);

test('an unset GF_SQLITE_PATH keeps persistence disabled and the shape unchanged', () => {
  const result = readFactoryConfig({ GF_API_TOKEN: VALID_TOKEN });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.config, { host: '127.0.0.1', port: 8787, token: VALID_TOKEN });
  assert.equal('sqlitePath' in result.config, false);
});

test('a set GF_SQLITE_PATH is trimmed and exposed', () => {
  const result = readFactoryConfig({
    GF_API_TOKEN: VALID_TOKEN,
    GF_SQLITE_PATH: '  /var/lib/gigaforge/factory.db  ',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.sqlitePath, '/var/lib/gigaforge/factory.db');
});

test('an empty GF_SQLITE_PATH is rejected', () => {
  for (const value of ['', '   ', '\t']) {
    const result = readFactoryConfig({ GF_API_TOKEN: VALID_TOKEN, GF_SQLITE_PATH: value });
    assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to be rejected`);
    if (result.ok) continue;
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /GF_SQLITE_PATH must not be empty when set/);
  }
});

test('a GF_SQLITE_PATH with a NUL byte is rejected', () => {
  const result = readFactoryConfig({
    GF_API_TOKEN: VALID_TOKEN,
    GF_SQLITE_PATH: '/var/lib/gigaforge/factory\u0000.db',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /GF_SQLITE_PATH must not contain NUL characters/);
});

test('a bad GF_SQLITE_PATH is reported together with other configuration errors', () => {
  const result = readFactoryConfig({ GF_API_TOKEN: 'short', GF_SQLITE_PATH: '   ' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.length, 2);
  assert.match(result.errors.join('\n'), /GF_API_TOKEN/);
  assert.match(result.errors.join('\n'), /GF_SQLITE_PATH must not be empty when set/);
});
