// The value-substitute fallback: fires only on a line no primary operator
// covers, and covers an exported const binding exactly as a local one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMutants } from '../lib/mutate.mjs';

const operatorsOf = (src) => generateMutants(src, { maxMutants: 1000 }).map((m) => m.operator);

test('value-substitute does not double-cover a const line a primary operator already mutates', () => {
  // Both off-by-one and the fallback's pattern match this line; only one may fire.
  assert.deepEqual(operatorsOf('const limit = 3;\n'), ['off-by-one']);
  assert.deepEqual(operatorsOf('const ok = a > b;\n'), ['invert-comparison']);
  assert.deepEqual(operatorsOf('export const N = 3;\n'), ['off-by-one']);
});

test('value-substitute covers an exported const bound to a call', () => {
  const mutants = generateMutants('export const tag = randomUUID();\n');
  assert.deepEqual(mutants.map((m) => [m.operator, m.mutated]), [
    ['value-substitute', 'export const tag = undefined;'],
  ]);
});

test('value-substitute covers an indented exported const bound to a string', () => {
  const mutants = generateMutants("  export const PINNED_REGISTRY = 'https://registry.npmjs.org/';\n");
  assert.deepEqual(mutants.map((m) => m.mutated), ['  export const PINNED_REGISTRY = undefined;']);
});

test('value-substitute still skips exported let/var and sentinel-bound exports', () => {
  assert.deepEqual(operatorsOf('export let y = f();\n'), []);
  assert.deepEqual(operatorsOf('export var y = f();\n'), []);
  assert.deepEqual(operatorsOf('export const x = undefined;\n'), []);
  assert.deepEqual(operatorsOf('export const x = null;\n'), []);
});
