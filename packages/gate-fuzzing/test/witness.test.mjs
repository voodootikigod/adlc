// §1.4 — flaky witness (mixed trials) → inconclusive (F8)
// Tests tree-level witness discrimination with N-trial unanimous rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discriminateWitness } from '../lib/witness.mjs';

// discriminates iff ALL baseline runs exit 0 AND ALL candidate runs exit non-0
// any flake → inconclusive

test('unanimous discrimination: all baseline pass, all candidate fail → discriminates', () => {
  let baselineCallCount = 0;
  let candidateCallCount = 0;
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') {
      baselineCallCount++;
      return { status: 0, timedOut: false };
    } else {
      candidateCallCount++;
      return { status: 1, timedOut: false };
    }
  };
  const result = discriminateWitness(
    { cmd: 'node', args: ['--test', 'test/foo.mjs'] },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 3, runFn }
  );
  assert.equal(result.discriminates, true);
  assert.equal(baselineCallCount, 3);
  assert.equal(candidateCallCount, 3);
});

test('flaky baseline (one baseline fails) → inconclusive, never discriminates', () => {
  let baselineCallCount = 0;
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') {
      baselineCallCount++;
      // Second baseline run fails (flaky!)
      return { status: baselineCallCount === 2 ? 1 : 0, timedOut: false };
    }
    return { status: 1, timedOut: false };
  };
  const result = discriminateWitness(
    { cmd: 'node', args: [] },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 3, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.match(result.reason, /inconclusive/);
});

test('flaky candidate (one candidate passes) → inconclusive, never discriminates', () => {
  let candidateCallCount = 0;
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') return { status: 0, timedOut: false };
    candidateCallCount++;
    // Third candidate run passes (flaky!)
    return { status: candidateCallCount === 3 ? 0 : 1, timedOut: false };
  };
  const result = discriminateWitness(
    { cmd: 'node', args: [] },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 3, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.match(result.reason, /inconclusive/);
});

test('witness timeout on baseline → inconclusive', () => {
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') return { status: null, timedOut: true };
    return { status: 1, timedOut: false };
  };
  const result = discriminateWitness(
    { cmd: 'node', args: [] },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 1, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.equal(result.reason, 'inconclusive');
});

test('witness timeout on candidate → inconclusive', () => {
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') return { status: 0, timedOut: false };
    return { status: null, timedOut: true };
  };
  const result = discriminateWitness(
    { cmd: 'node', args: [] },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 2, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.equal(result.reason, 'inconclusive');
});

test('witness passes on baseline AND candidate → does not discriminate', () => {
  const runFn = () => ({ status: 0, timedOut: false });
  const result = discriminateWitness(
    { cmd: 'node', args: [] },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 1, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.match(result.reason, /candidate/);
});

test('witness fails on baseline AND candidate → does not discriminate', () => {
  const runFn = () => ({ status: 1, timedOut: false });
  const result = discriminateWitness(
    { cmd: 'node', args: [] },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 1, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.match(result.reason, /baseline/);
});
