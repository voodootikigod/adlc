// Tests for the mining pipeline — uses fixture gh JSON, zero real gh calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSignals, buildClusters } from '../lib/mine.mjs';
import { runGh, fetchPRList, fetchPRDetail, fetchPRsGraphQL } from '../lib/gh.mjs';

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

test('fetchSignals: counts skipped PRs on JSON parse error in detail', async () => {
  const invalidJsonRunner = (args) => {
    const key = args.join(',');
    // PR list succeeds
    if (key === 'pr,list,--state,all,--limit,10,--json,number,title') {
      return JSON.stringify([{ number: 99, title: 'Bad JSON PR' }]);
    }
    // PR view returns invalid JSON
    return 'Gateway Timeout 504';
  };

  const { signals, totalPRs, skippedPRs } = await fetchSignals({
    limit: 10,
    ghRunner: invalidJsonRunner,
  });

  assert.strictEqual(totalPRs, 1);
  assert.strictEqual(skippedPRs, 1);
  assert.strictEqual(signals.length, 0);
});

test('fetchPRList: throws GH_PARSE_ERROR on JSON parse error', async () => {
  const invalidJsonRunner = (args) => {
    // PR list returns invalid JSON
    return 'Gateway Timeout 504';
  };

  try {
    await fetchSignals({
      limit: 10,
      ghRunner: invalidJsonRunner,
    });
    assert.fail('Should have thrown an error');
  } catch (err) {
    assert.strictEqual(err.code, 'GH_PARSE_ERROR');
  }
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

test('runGh: enforces 64 MiB maxBuffer, 60s timeout, and SIGKILL on execFileSync', () => {
  let seenBin = null;
  let seenArgs = null;
  let seenOpts = null;
  const out = runGh(['pr', 'list'], (bin, args, opts) => {
    seenBin = bin;
    seenArgs = args;
    seenOpts = opts;
    return '[]';
  });
  assert.strictEqual(out, '[]');
  assert.strictEqual(seenBin, 'gh');
  assert.deepStrictEqual(seenArgs, ['pr', 'list']);
  assert.strictEqual(seenOpts.maxBuffer, 64 * 1024 * 1024);
  assert.strictEqual(seenOpts.timeout, 60_000);
  assert.strictEqual(seenOpts.killSignal, 'SIGKILL');
});

test('runGh / fetchPRList / fetchPRDetail pin --repo on pr commands without duplicating (T-P19)', () => {
  const calls = [];
  const fakeExec = (_bin, args) => {
    calls.push(args);
    return args[1] === 'list' ? '[]' : '{"reviews":[],"comments":[]}';
  };
  runGh(['pr', 'list'], fakeExec, { repo: 'acme/app' });
  runGh(['--version'], fakeExec, { repo: 'acme/app' });
  runGh(['pr', 'list', '--repo', 'other/repo'], fakeExec, { repo: 'acme/app' });
  assert.deepStrictEqual(calls[0], ['pr', 'list', '--repo', 'acme/app']);
  assert.deepStrictEqual(calls[1], ['--version']);
  assert.deepStrictEqual(calls[2], ['pr', 'list', '--repo', 'other/repo']);

  const runnerCalls = [];
  const runner = (args) => {
    runnerCalls.push(args);
    return args[1] === 'list' ? '[]' : '{"reviews":[],"comments":[]}';
  };
  fetchPRList(5, runner, { repo: 'acme/app' });
  fetchPRDetail(42, runner, { repo: 'acme/app' });
  assert.ok(runnerCalls[0].includes('--repo') && runnerCalls[0].includes('acme/app'));
  assert.ok(runnerCalls[1].includes('--repo') && runnerCalls[1].includes('acme/app'));
});

test('fetchSignals uses a single gh api graphql call when GraphQL is supported', async () => {
  const calls = [];
  const gqlRunner = (args) => {
    calls.push(args);
    assert.equal(args[0], 'api');
    assert.equal(args[1], 'graphql');
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 10,
                title: 'Add auth',
                reviews: {
                  nodes: [
                    { body: "don't expose raw stack traces to clients", author: { login: 'alice' } },
                    { body: 'LGTM', author: { login: 'bob' } },
                  ],
                },
                comments: {
                  nodes: [
                    { body: 'avoid hardcoding secrets in source files', author: { login: 'carol' } },
                  ],
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  };

  const res = await fetchSignals({ limit: 50, ghRunner: gqlRunner });
  assert.equal(calls.length, 1, 'should issue exactly one gh api graphql call');
  assert.equal(res.totalPRs, 1);
  assert.equal(res.skippedPRs, 0);
  assert.equal(res.firstError, null);
  assert.equal(res.signals.length, 2);
  assert.ok(res.signals.every((s) => s.prNumber === 10));
});

test('fetchPRsGraphQL paginates across cursors, pins owner/name when repo is set, and caps at limit', () => {
  const calls = [];
  const paginatedRunner = (args) => {
    calls.push(args);
    if (calls.length === 1) {
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                { number: 1, title: 'PR 1', reviews: { nodes: [] }, comments: { nodes: [] } },
                { number: 2, title: 'PR 2', reviews: { nodes: [] }, comments: { nodes: [] } },
              ],
              pageInfo: { hasNextPage: true, endCursor: 'CUR_1' },
            },
          },
        },
      });
    }
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: [
              { number: 3, title: 'PR 3', reviews: { nodes: [] }, comments: { nodes: [] } },
              { number: 4, title: 'PR 4', reviews: { nodes: [] }, comments: { nodes: [] } },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'CUR_2' },
          },
        },
      },
    });
  };

  const prs = fetchPRsGraphQL(3, paginatedRunner, { repo: 'acme/widgets' });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('owner=acme') && calls[0].includes('name=widgets'));
  assert.ok(calls[1].includes('after=CUR_1'));
  assert.deepEqual(prs.map((p) => p.number), [1, 2, 3]);
  assert.deepEqual(fetchPRsGraphQL(0, paginatedRunner), []);

  // GitHub GraphQL API caps connection `first` arguments at 100.
  const capCalls = [];
  const capRunner = (args) => {
    capCalls.push(args);
    const queryArg = args.find((a) => a.startsWith('query=')) ?? '';
    assert.match(queryArg, /states:\s*\[OPEN,\s*CLOSED,\s*MERGED\]/, 'GraphQL query must include all PR states');
    assert.match(queryArg, /reviews\(first: 100\)/, 'reviews connection must stay within GitHub 100-node cap');
    assert.match(queryArg, /comments\(first: 100\)/, 'comments connection must stay within GitHub 100-node cap');
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: [{ number: 1, title: 'PR 1', reviews: { nodes: [] }, comments: { nodes: [] } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    });
  };
  fetchPRsGraphQL(150, capRunner);
  assert.ok(capCalls[0].includes('first=100'), 'page size must be capped at 100 for limit > 100');
});

test('fetchSignals hydrates PRs whose nested reviews/comments have hasNextPage via fetchPRDetail', async () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 50,
                  title: 'Small PR',
                  reviews: { nodes: [{ body: 'avoid raw SQL here', author: { login: 'a' } }], pageInfo: { hasNextPage: false } },
                  comments: { nodes: [], pageInfo: { hasNextPage: false } },
                },
                {
                  number: 51,
                  title: 'Huge PR',
                  reviews: { nodes: [], pageInfo: { hasNextPage: false } },
                  comments: { nodes: [{ body: 'LGTM', author: { login: 'b' } }], pageInfo: { hasNextPage: true } },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '51') {
      return JSON.stringify({
        reviews: [],
        comments: [{ body: "don't leak secrets from comment 101", author: { login: 'c' } }],
      });
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };

  const res = await fetchSignals({ limit: 10, ghRunner: runner });
  assert.equal(calls.length, 2, '1 graphql call + 1 pr view hydration only for the truncated PR');
  assert.equal(res.totalPRs, 2);
  assert.equal(res.skippedPRs, 0);
  assert.equal(res.signals.length, 2);
  assert.ok(res.signals.some((s) => s.prNumber === 51 && s.body.includes('comment 101')));
});

test('fetchPRsGraphQL throws GH_GRAPHQL_ERROR on GraphQL errors and fetchSignals falls back cleanly', async () => {
  const fallbackRunner = (args) => {
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ errors: [{ message: 'rate limited' }] });
    }
    if (args[0] === 'pr' && args[1] === 'list') {
      return JSON.stringify([{ number: 7, title: 'Fallback PR' }]);
    }
    return JSON.stringify({
      reviews: [{ body: "never expose internal stack traces", author: { login: 'dana' } }],
      comments: [],
    });
  };

  assert.throws(
    () => fetchPRsGraphQL(5, fallbackRunner),
    (err) => err.code === 'GH_GRAPHQL_ERROR',
  );
  const res = await fetchSignals({ limit: 5, ghRunner: fallbackRunner });
  assert.equal(res.totalPRs, 1);
  assert.equal(res.signals.length, 1);
});
