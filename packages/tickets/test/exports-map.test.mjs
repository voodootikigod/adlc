import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the public surface is declared', () => {
  assert.deepEqual(Object.keys(pkg.exports).sort(), [
    '.',
    './lib/durability.mjs',
    './lib/key-contract.mjs',
    './lib/manifest-primitives.mjs',
    './package.json',
  ]);
});

test('every public lib subpath loads by package name', async () => {
  const libKeys = Object.keys(pkg.exports).filter((k) => k.startsWith('./lib/'));
  for (const key of libKeys) {
    const mod = await import(pkg.name + key.slice(1));
    assert.ok(Object.keys(mod).length > 0, `module ${key} should have at least one export`);
  }
});
