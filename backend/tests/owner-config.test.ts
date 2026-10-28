import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFactoryConfig } from '../src/config.ts';
import { formatUsage, runCli } from '../src/main.ts';
import { TEST_TOKEN } from './helpers.ts';

test('owner configuration is explicit while omitted/empty preserve the old config shape', () => {
  for (const ownerId of [undefined, '']) {
    assert.deepEqual(readFactoryConfig({ GF_API_TOKEN: TEST_TOKEN, GF_OWNER_ID: ownerId }), { ok: true, config: { host: '127.0.0.1', port: 8787, token: TEST_TOKEN } });
  }
  assert.deepEqual(readFactoryConfig({ GF_API_TOKEN: TEST_TOKEN, GF_OWNER_ID: 'owner_test' }), { ok: true, config: { host: '127.0.0.1', port: 8787, token: TEST_TOKEN, ownerId: 'owner_test' } });
});

test('invalid owner identity rejects startup without echoing its value', async () => {
  for (const ownerId of [' ', 'owner\ncontrol', '../owner', 'a'.repeat(65)]) {
    const result = readFactoryConfig({ GF_API_TOKEN: TEST_TOKEN, GF_OWNER_ID: ownerId });
    assert.equal(result.ok, false);
    let started = false;
    const stderr: string[] = [];
    const code = await runCli({ argv: [], env: { GF_API_TOKEN: TEST_TOKEN, GF_OWNER_ID: ownerId }, stdout: () => {}, stderr: line => stderr.push(line), startServer: async () => { started = true; throw new Error('must not start'); } });
    assert.equal(code, 1); assert.equal(started, false);
    assert.ok(stderr.some(line => line.includes('GF_OWNER_ID')));
    if (ownerId.length > 1) assert.equal(stderr.join('\n').includes(ownerId), false);
  }
});

test('CLI help documents owner sessions, grant administration and the existing server command', () => {
  const help = formatUsage();
  assert.ok(help.includes('bun backend/main.ts'));
  for (const expected of ['GF_OWNER_ID', '/v1/owner/sessions', '/v1/owner/grants']) assert.ok(help.includes(expected));
  assert.equal(help.includes(TEST_TOKEN), false);
});
