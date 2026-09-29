// CONVENTIONS rule 2: a helper core exports is imported from core, never kept
// as a local copy, so a defect fixed in core reaches every caller.
// @adlc/tickets is exempt because core imports it: tickets cannot import core
// back without a cycle, so its own copy is the only option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = join(ROOT, 'packages');
const OWNERS = new Set(['core', 'tickets']);
const SKIP = new Set(['test', 'cli-test', 'adapter-test', 'node_modules']);
const PROMOTED = ['isPlainObject'];

export function definesHelper(source, name) {
  const re = new RegExp(String.raw`(?:\bfunction\s+${name}\s*\(|\b(?:const|let|var)\s+${name}\s*=)`);
  return re.test(source);
}

function sources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sources(full));
    else if (entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

test('definesHelper recognises function and binding definitions, not calls or imports', () => {
  assert.equal(definesHelper('function isPlainObject(v) {}', 'isPlainObject'), true);
  assert.equal(definesHelper('const isPlainObject = (v) => v;', 'isPlainObject'), true);
  assert.equal(definesHelper("import { isPlainObject } from '@adlc/core';\nisPlainObject(x);", 'isPlainObject'), false);
});

test('no package outside core and tickets keeps a local copy of a promoted core helper', () => {
  const offenders = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory() || OWNERS.has(entry.name)) continue;
    for (const file of sources(join(PACKAGES, entry.name))) {
      const body = readFileSync(file, 'utf8');
      for (const name of PROMOTED) {
        if (definesHelper(body, name)) offenders.push(`${relative(ROOT, file)}: ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `import these from @adlc/core instead:\n  ${offenders.join('\n  ')}`);
});
