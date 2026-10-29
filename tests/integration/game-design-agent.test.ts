import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('game design advisor exposes only read tools and no extensions', async () => {
  const text = await readFile(resolve(root, '.pi/agents/game-design.md'), 'utf8');
  const [frontmatter, prompt] = text.split(/^---\s*$/m).slice(1);
  assert.match(frontmatter, /^name:\s*game-design\s*$/m);
  assert.match(frontmatter, /^tools:\s*read,\s*grep,\s*find,\s*ls\s*$/m);
  assert.match(frontmatter, /^extensions:\s*$/m);
  assert.ok(prompt.includes('Do not create or modify files'));
  assert.ok(prompt.includes('human approval'));
  assert.ok(prompt.includes('path and line'));
});
