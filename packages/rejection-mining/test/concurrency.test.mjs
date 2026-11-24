import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineClusters, DEFAULT_LLM_CONCURRENCY } from '../lib/llm.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('rejection-mining refineClusters enforces bounded concurrency and preserves all cluster indices', async () => {
  assert.equal(DEFAULT_LLM_CONCURRENCY, 4);
  const signals = Array.from({ length: 6 }, (_, i) => ({
    body: `avoid bug ${i}`,
    author: 'alice',
    prNumber: i + 1,
  }));
  const clusters = signals.map((_, i) => ({ slug: `cluster-${i}`, indices: [i] }));

  let inFlight = 0;
  let maxInFlight = 0;
  const refineClusterFn = async (slug) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await delay(15);
    inFlight--;
    if (slug === 'cluster-2') throw new Error('simulated transient error');
    return { title: `Title ${slug}`, charter: `Charter ${slug}` };
  };

  const results = await refineClusters(clusters, signals, 'mid', {
    concurrency: 2,
    refineClusterFn,
  });

  assert.equal(maxInFlight, 2, 'must respect concurrency cap of 2');
  assert.equal(results.size, 5, 'non-fatal failure on one cluster must not drop others');
  assert.equal(results.has(2), false);
  assert.equal(results.get(0).title, 'Title cluster-0');
  assert.equal(results.get(5).title, 'Title cluster-5');
});

test('rejection-mining refineClusters falls back to DEFAULT_LLM_CONCURRENCY on invalid concurrency', async () => {
  const signals = [{ body: 'avoid bug', author: 'a', prNumber: 1 }];
  const clusters = [{ slug: 'c0', indices: [0] }];
  const res = await refineClusters(clusters, signals, 'mid', {
    concurrency: 0,
    refineClusterFn: async () => ({ title: 'T', charter: 'C' }),
  });
  assert.equal(res.get(0).title, 'T');
});
