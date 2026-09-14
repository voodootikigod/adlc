// Tests for LLM refinement bookkeeping. The refinement function is injected so
// these tests never call a provider or require credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allRefinementsFailed, isLlmRequested, refineClusters } from '../lib/llm.mjs';

const clusters = [
  { slug: 'success', indices: [0] },
  { slug: 'empty-response', indices: [1] },
  { slug: 'provider-error', indices: [2] },
];
const signals = [
  { body: 'first objection' },
  { body: 'second objection' },
  { body: 'third objection' },
];

test('refineClusters: counts null and thrown refinements while retaining successes', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const outcome = await refineClusters(clusters, signals, 'mid', async (slug) => {
      if (slug === 'success') return { title: 'Success', charter: 'success charter' };
      if (slug === 'empty-response') return null;
      throw new Error('provider unavailable');
    });

    assert.deepStrictEqual([...outcome.results.keys()], [0]);
    assert.strictEqual(outcome.attempted, 3);
    assert.strictEqual(outcome.failed, 2);
  } finally {
    console.error = originalError;
  }
});

test('allRefinementsFailed: only fails when --llm had no successful cluster', () => {
  assert.strictEqual(allRefinementsFailed({ requested: true, attempted: 3, successful: 0 }), true);
  assert.strictEqual(allRefinementsFailed({ requested: true, attempted: 3, successful: 1 }), false);
  assert.strictEqual(allRefinementsFailed({ requested: false, attempted: 3, successful: 0 }), false);
  assert.strictEqual(allRefinementsFailed({ requested: true, attempted: 0, successful: 0 }), false);
});

test('isLlmRequested: only requests refinement when enabled and clusters exist', () => {
  assert.strictEqual(isLlmRequested(true, 3), true);
  assert.strictEqual(isLlmRequested(true, 0), false);
  assert.strictEqual(isLlmRequested(false, 3), false);
});
