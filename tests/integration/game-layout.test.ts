import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const text = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('Godot resources and frozen wire contract have a single active owner', () => {
  for (const path of ['game/project.godot', 'game/scenes/main.tscn', 'game/scripts/main.gd.uid', 'game/tests/fixtures', 'contracts/factory-api.md']) {
    assert.ok(existsSync(resolve(root, path)), path);
  }
  assert.equal(existsSync(resolve(root, 'gf')), false);
  assert.equal(existsSync(resolve(root, 'docs/factory-api.md')), false);
});

test('root orchestration exposes the game and real integration runners without packaging game resources', () => {
  const manifest = JSON.parse(text('package.json'));
  assert.equal(manifest.scripts['test:game'], 'bash game/tests/run_checks.sh');
  assert.equal(manifest.scripts['test:integration'], 'bash tests/integration/run_backend_smoke.sh');
  assert.ok(JSON.parse(text('tsconfig.json')).exclude.includes('game'));
  assert.ok(text('.dockerignore').split(/\r?\n/).includes('game'));
});

for (const [script, fixture, invalidKind] of [
  ['game/tests/run_checks.sh', 'godot-checks-help.txt', 'option'],
  ['tests/integration/run_backend_smoke.sh', 'godot-backend-help.txt', 'argument'],
] as const) {
  test(`${script}: help and rejected input preserve the public shell interface from another cwd`, () => {
    const invoke = (argument: string) => {
      const result = spawnSync('bash', [resolve(root, script), argument], {
        cwd: resolve(root, 'backend'), encoding: 'utf8',
        env: { ...process.env, GODOT_BIN: '', GF_API_TOKEN: '', GF_BACKEND_URL: '' },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    assert.deepEqual(invoke('--help'), {
      status: 0, stdout: text(`tests/integration/fixtures/${fixture}`), stderr: '',
    });
    assert.deepEqual(invoke('--layout-invalid'), {
      status: 2, stdout: '', stderr: `ERROR: unknown ${invalidKind} '--layout-invalid' (try --help)\n`,
    });
  });
}
