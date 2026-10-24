// reason-list.test.mjs — reasonList(): a heading, then one reason per line.
// Pure — no I/O, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasonList } from '../lib/text.mjs';
import * as core from '../index.mjs';

test('reasonList is exported from the core root', () => {
  assert.equal(core.reasonList, reasonList);
});

test('reasonList with no reasons returns the heading alone', () => {
  assert.equal(reasonList('refused:', []), 'refused:');
});

test('reasonList with one reason keeps it on the heading line', () => {
  assert.equal(reasonList('refused:', ['ticket is required']), 'refused: ticket is required');
});

test('reasonList with several reasons prints one per line, indented two spaces', () => {
  assert.equal(
    reasonList('refused:', ['ticket is required', 'packet is required', 'p5 missing']),
    'refused:\n  ticket is required\n  packet is required\n  p5 missing',
  );
});

test('reasonList never changes the reason text', () => {
  const reasons = ['a; b (keeps its own "; ")', '  leading spaces kept', 'trailing.'];
  const lines = reasonList('h:', reasons).split('\n');
  assert.deepEqual(lines.slice(1).map((line) => line.slice(2)), reasons);
});

test('reasonList does not mutate its input', () => {
  const reasons = Object.freeze(['one', 'two']);
  assert.doesNotThrow(() => reasonList('h:', reasons));
  assert.deepEqual([...reasons], ['one', 'two']);
});
