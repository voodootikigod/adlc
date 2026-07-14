import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TOOLKIT_GROUPS, ALL_PACKAGES } from '../lib/toolkit-packages.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.join(__dirname, '..', '..', '..', 'packages');

test('listed packages and packages/ directories match exactly (bijective)', () => {
  const onDisk = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.deepEqual([...ALL_PACKAGES].sort(), onDisk);
});

test('no package appears in two groups', () => {
  assert.equal(new Set(ALL_PACKAGES).size, ALL_PACKAGES.length);
});

test('every package has a toolkit docs page', () => {
  for (const name of ALL_PACKAGES) {
    const p = path.join(__dirname, '..', 'content', 'docs', 'toolkit', `${name}.mdx`);
    assert.ok(existsSync(p), `missing docs page for ${name}`);
    assert.ok(existsSync(path.join(packagesDir, name, 'package.json')), `${name}: not a publishable package`);
  }
});

test('groups are non-empty and labeled', () => {
  assert.ok(TOOLKIT_GROUPS.length >= 4);
  for (const g of TOOLKIT_GROUPS) {
    assert.ok(g.group.length > 0);
    assert.ok(g.packages.length > 0);
  }
});
