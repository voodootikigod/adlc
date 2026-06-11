// Tests for the mining pipeline — uses fixture gh JSON, zero real gh calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSignals, buildClusters } from '../lib/mine.mjs';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

// Fixture gh responses keyed by serialized call signature
const GH_FIXTURES = {
  // pr list
  'pr,list,--state,all,--limit,10,--json,number,title': JSON.stringify([
    { number: 1, title: 'Add user auth' },
    { number: 2, title: 'Refactor DB layer' },
    { number: 3, title: 'Fix null pointer' },
  ]),
  // pr view 1
  'pr,view,1,--json,reviews,comments': JSON.stringify({
    reviews: [
      { body: "don't expose the raw error to the client here", author: { login: 'alice' } },
      { body: 'LGTM overall', author: { login: 'bob' } },
    ],
    comments: [
      { body: "avoid hardcoding the connection string, use environment variables instead", author: { login: 'carol' } },
    ],
  }),
  // pr view 2
  'pr,view,2,--json,reviews,comments': JSON.stringify({
    reviews: [
      { body: "never expose raw stack traces to users in production", author: { login: 'dave' } },
      { body: 'Good change overall', author: { login: 'eve' } },
    ],
    comments: [
      { body: "avoid hardcoding connection strings, always use env vars instead", author: { login: 'frank' } },
    ],
  }),
  // pr view 3
  'pr,view,3,--json,reviews,comments': JSON.stringify({
    reviews: [
      { body: 'Missing error handling in the fetch wrapper', author: { login: 'grace' } },
    ],
    comments: [],
  }),
};

/**
 * Mock ghRunner that uses fixtures.
 */
function mockGhRunner(args) {
  const key = args.join(',');
  if (!(key in GH_FIXTURES)) {
    throw new Error(`No fixture for gh ${args.join(' ')}`);
  }
  return GH_FIXTURES[key];
}

// ---------------------------------------------------------------------------
// fetchSignals
// ---------------------------------------------------------------------------

test('fetchSignals: extracts negative signals from fixture PRs', async () => {
  const { signals, totalPRs, skippedPRs } = await fetchSignals({
    limit: 10,
    ghRunner: mockGhRunner,
  });

  assert.strictEqual(totalPRs, 3);
  assert.strictEqual(skippedPRs, 0);
  // Should have negative signals, not positive ones
  assert(signals.length > 0);
  // LGTM and "Good change" should be filtered out
  assert(signals.every((s) => !s.body.includes('LGTM')));
  assert(signals.every((s) => !s.body.includes('Good change')));
});

test('fetchSignals: each signal has prNumber, author, source', async () => {
  const { signals } = await fetchSignals({ limit: 10, ghRunner: mockGhRunner });
  for (const s of signals) {
    assert(typeof s.prNumber === 'number');
    assert(typeof s.author === 'string');
    assert(['review', 'comment'].includes(s.source));
  }
});

test('fetchSignals: counts skipped PRs on fetch error', async () => {
  const flakyRunner = (args) => {
    const key = args.join(',');
    // PR list succeeds
    if (key === 'pr,list,--state,all,--limit,10,--json,number,title') {
      return JSON.stringify([{ number: 99, title: 'Flaky PR' }]);
    }
    // PR view always fails
    throw new Error('network error');
  };

  const { signals, totalPRs, skippedPRs } = await fetchSignals({
    limit: 10,
    ghRunner: flakyRunner,
  });

  assert.strictEqual(totalPRs, 1);
  assert.strictEqual(skippedPRs, 1);
  assert.strictEqual(signals.length, 0);
});

test('fetchSignals: empty PR list returns zero', async () => {
  const emptyRunner = (args) => {
    if (args.join(',').includes('pr,list')) return JSON.stringify([]);
    throw new Error('should not be called');
  };
  const result = await fetchSignals({ limit: 10, ghRunner: emptyRunner });
  assert.strictEqual(result.totalPRs, 0);
  assert.strictEqual(result.signals.length, 0);
});

// ---------------------------------------------------------------------------
// buildClusters
// ---------------------------------------------------------------------------

test('buildClusters: clusters similar signals', () => {
  const signals = [
    { body: "avoid hardcoding connection strings, use env vars instead", author: 'a', prNumber: 1 },
    { body: "avoid hardcoding connection strings, always use environment variables", author: 'b', prNumber: 2 },
    { body: 'missing null check causes crash in production', author: 'c', prNumber: 3 },
  ];
  // Two hardcoding signals should cluster together at threshold 0.4
  const clusters = buildClusters(signals, 1, 0.4);
  // At min=1 we get all groups
  assert(clusters.length >= 1);
  // The two similar hardcoding ones should be in one cluster
  const bigCluster = clusters.find((c) => c.count >= 2);
  assert(bigCluster, 'expected a cluster of at least 2 similar signals');
});

test('buildClusters: respects --min threshold', () => {
  const signals = [
    { body: "don't hardcode the API key here", author: 'a', prNumber: 1 },
    { body: "never hardcode API keys in code", author: 'b', prNumber: 2 },
    { body: 'missing error handling', author: 'c', prNumber: 3 },
  ];
  // With min=2, single-item clusters should be excluded
  const clusters = buildClusters(signals, 2);
  assert(clusters.every((c) => c.count >= 2));
});

test('buildClusters: each cluster has slug, indices, count, prNumbers', () => {
  const signals = [
    { body: "don't expose error details to client", author: 'a', prNumber: 1 },
    { body: "never expose stack traces to clients", author: 'b', prNumber: 2 },
  ];
  const clusters = buildClusters(signals, 1);
  for (const c of clusters) {
    assert(typeof c.slug === 'string');
    assert(Array.isArray(c.indices));
    assert(typeof c.count === 'number');
    assert(c.prNumbers instanceof Set);
  }
});

test('buildClusters: empty signals → empty clusters', () => {
  assert.deepStrictEqual(buildClusters([], 2), []);
});
