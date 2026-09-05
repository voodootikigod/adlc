// Offline tests for LLM refinement status and per-cluster fallback behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineClusters } from '../lib/llm.mjs';

const clusters = [
  { slug: 'first', indices: [0] },
  { slug: 'second', indices: [1] },
];
const signals = [{ body: 'first objection' }, { body: 'second objection' }];

test('refineClusters: records all failed clusters without throwing', async () => {
  const status = await refineClusters(clusters, signals, 'mid', async () => {
    throw new Error('provider unavailable');
  });

  assert.equal(status.results.size, 0);
  assert.deepEqual(status.failures.map(({ index, slug }) => ({ index, slug })), [
    { index: 0, slug: 'first' },
    { index: 1, slug: 'second' },
  ]);
});

test('refineClusters: preserves successful results and records invalid responses', async () => {
  const status = await refineClusters(clusters, signals, 'mid', async (slug) => {
    if (slug === 'first') return { title: 'First', charter: 'first charter' };
    return null;
  });

  assert.deepEqual(status.results.get(0), { title: 'First', charter: 'first charter' });
  assert.deepEqual(status.failures, [
    { index: 1, slug: 'second', reason: 'invalid or empty LLM response' },
  ]);
});
