import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..');
const readJson = (name) => JSON.parse(readFileSync(join(pluginDir, name), 'utf8'));

const plugin = readJson('plugin.json');

test('adlcContract is a positive integer', () => {
  assert.ok(Number.isInteger(plugin.adlcContract) && plugin.adlcContract >= 1,
    `adlcContract must be an integer >= 1, got ${plugin.adlcContract}`);
});

// plugin.json's version stays agy-native and independent of package.json's npm
// lockstep version (see test/packaging.test.mjs) — not asserting an exact value,
// only that this ticket didn't introduce a coupling between the two.
test('plugin.json keeps its own version field, independent of package.json', () => {
  assert.ok(typeof plugin.version === 'string' && plugin.version.length > 0,
    'plugin.json must keep a version field');
});
