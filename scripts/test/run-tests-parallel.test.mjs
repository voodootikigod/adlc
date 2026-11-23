import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTestConcurrency, runSegmentsPool, packageSegments, MAX_DEFAULT_CONCURRENCY } from '../run-tests.mjs';
import { buildFastPreflightGates, runFastPreflight } from '../preflight-fast.mjs';

test('resolveTestConcurrency respects ADLC_TEST_CONCURRENCY and caps default at MAX_DEFAULT_CONCURRENCY', () => {
  assert.equal(MAX_DEFAULT_CONCURRENCY, 6);
  assert.equal(resolveTestConcurrency({}, 16), 6);
  assert.equal(resolveTestConcurrency({}, 3), 3);
  assert.equal(resolveTestConcurrency({ ADLC_TEST_CONCURRENCY: '1' }, 16), 1);
  assert.equal(resolveTestConcurrency({ ADLC_TEST_CONCURRENCY: '4' }, 16), 4);
  assert.equal(resolveTestConcurrency({ ADLC_TEST_CONCURRENCY: '0' }, 4), 4);
  assert.equal(resolveTestConcurrency({ ADLC_TEST_CONCURRENCY: 'bad' }, 4), 4);
});

test('runSegmentsPool bounds concurrency and flushes output deterministically in segment order', async () => {
  let active = 0;
  let maxActive = 0;
  const flushed = [];
  const segments = [
    ['seg-0', 'cmd-0'],
    ['seg-1', 'cmd-1'],
    ['seg-2', 'cmd-2'],
    ['seg-3', 'cmd-3'],
  ];
  const delays = { 'seg-0': 40, 'seg-1': 5, 'seg-2': 25, 'seg-3': 5 };

  const results = await runSegmentsPool(segments, {
    concurrency: 2,
    runOne: async (_cmd, _env, name) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, delays[name]));
      active--;
      return { status: name === 'seg-2' ? 1 : 0, signal: null, output: `out:${name}\n` };
    },
    onResult: (r) => flushed.push(r.name),
  });

  assert.equal(maxActive, 2, 'concurrency must never exceed 2');
  assert.deepEqual(flushed, ['seg-0', 'seg-1', 'seg-2', 'seg-3'], 'results flush strictly in segment order');
  assert.equal(results[2].status, 1);
  assert.equal(results[0].status, 0);
});

test('packageSegments excludes packages/autopilot/test/spec-coverage.test.mjs from pass 1', () => {
  const segs = packageSegments();
  const autopilot = segs.find(([name]) => name === 'packages/autopilot');
  assert.ok(autopilot, 'packages/autopilot segment exists');
  assert.ok(!autopilot[1].includes('spec-coverage.test.mjs'), 'spec-coverage.test.mjs excluded from pass 1');
  assert.ok(autopilot[1].includes('packages/autopilot/test/ci.test.mjs'), 'other autopilot tests remain included');
});

test('preflight-fast runs sub-second static gates before run-tests and mutation-gate and fails fast', () => {
  const gates = buildFastPreflightGates('origin/main');
  const names = gates.map((g) => g.name);
  assert.deepEqual(names, [
    'toolkit-floor',
    'rail-freeze',
    'findings-ledger',
    'findings-append-only',
    'reviewer-directed-comments',
    'tests',
    'mutation-gate',
  ]);
  assert.deepEqual(gates[1].argv, ['node', ['scripts/rails-guard-ci.mjs', 'origin/main']]);
  assert.deepEqual(gates[3].argv, ['node', ['scripts/guard-findings-ledger-append-only.mjs', 'origin/main']]);
  assert.deepEqual(gates[4].argv, ['node', ['scripts/check-reviewer-directed-comments.mjs', 'origin/main']]);

  const ran = [];
  let observedCwd = null;
  const res = runFastPreflight({
    base: 'origin/main',
    spawn: (_bin, args, opts) => {
      observedCwd = opts.cwd;
      ran.push(args[0]);
      return { status: args[0].includes('rails-guard-ci') ? 2 : 0 };
    },
  });
  assert.equal(typeof observedCwd, 'string');
  assert.ok(observedCwd.length > 0);
  assert.equal(res.ok, false);
  assert.equal(res.failedGate, 'rail-freeze');
  assert.equal(res.status, 2);
  assert.deepEqual(ran, ['scripts/toolkit-floor-check.mjs', 'scripts/rails-guard-ci.mjs']);

  const staticRan = [];
  const staticOk = runFastPreflight({
    base: 'origin/main',
    staticOnly: true,
    spawn: (_bin, args) => {
      staticRan.push(args[0]);
      return { status: 0 };
    },
  });
  assert.equal(staticOk.ok, true);
  assert.equal(staticRan.length, 5);
});
