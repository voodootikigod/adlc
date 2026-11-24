import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refineClusters, DEFAULT_LLM_CONCURRENCY } from '../lib/llm.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('lesson-foundry refineClusters enforces bounded concurrency and handles non-fatal errors', async () => {
  assert.equal(DEFAULT_LLM_CONCURRENCY, 4);
  const findings = Array.from({ length: 6 }, (_, i) => ({
    desc: `finding ${i}`,
    category: 'security',
    severity: 'high',
    file: `src/f${i}.mjs`,
  }));
  const clusters = findings.map((_, i) => ({ name: `cluster-${i}`, indices: [i] }));

  let inFlight = 0;
  let maxInFlight = 0;
  const results = await refineClusters(clusters, findings, 'mid', {
    concurrency: 2,
    refineClusterFn: async (name) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await delay(15);
      inFlight--;
      if (name === 'cluster-3') throw new Error('transient LLM error');
      return { name, description: `Desc ${name}`, rule: `Rule ${name}` };
    },
  });

  assert.equal(maxInFlight, 2);
  assert.equal(results.size, 5);
  assert.equal(results.has(3), false);
  assert.equal(results.get(0).rule, 'Rule cluster-0');
  assert.equal(results.get(5).rule, 'Rule cluster-5');
});

test('lesson-foundry refineClusters falls back to DEFAULT_LLM_CONCURRENCY on invalid concurrency', async () => {
  const findings = [{ desc: 'f', category: 'c', severity: 's', file: 'a.mjs' }];
  const clusters = [{ name: 'c0', indices: [0] }];
  const res = await refineClusters(clusters, findings, 'mid', {
    concurrency: -2,
    refineClusterFn: async () => ({ name: 'n', description: 'd', rule: 'r' }),
  });
  assert.equal(res.get(0).name, 'n');
});
