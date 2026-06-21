import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'claude-code-plugin-smoke.mjs');
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('claude-code-plugin-smoke passes against the repo', () => {
  const result = spawnSync(process.execPath, [SCRIPT, REPO], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `smoke test failed:\n${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.ok, true);
});
