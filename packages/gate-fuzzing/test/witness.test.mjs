// §1.4 — flaky witness (mixed trials) → inconclusive (F8)
// Tests tree-level witness discrimination with N-trial unanimous rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discriminateWitness, runWitness, verifyWitness } from '../lib/witness.mjs';

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

test('runWitness records spawnError and does not set timedOut on ENOENT', () => {
  const result = runWitness({ cmd: '__nonexistent_binary_for_test_404__' }, process.cwd());
  assert.equal(result.status, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.spawnError, 'ENOENT');
});

test('runWitness sets timedOut: true and spawnError: null on timeout', () => {
  const runFn = () => ({ status: null, exitCode: null, timedOut: true, spawnError: null });
  const result = runWitness({ cmd: 'node' }, process.cwd(), runFn);
  assert.equal(result.timedOut, true);
  assert.equal(result.spawnError, null);
});

test('verifyWitness rejects when base has spawnError', () => {
  const base = { status: null, exitCode: null, timedOut: false, spawnError: 'ENOENT' };
  const cand = { status: 1, exitCode: 1, timedOut: false, spawnError: null };
  const result = verifyWitness(base, cand);
  assert.equal(result.verified, false);
  assert.equal(result.discriminates, false);
  assert.match(result.reason, /could not start.*ENOENT/);
});

test('verifyWitness rejects when candidate has spawnError', () => {
  const base = { status: 0, exitCode: 0, timedOut: false, spawnError: null };
  const cand = { status: null, exitCode: null, timedOut: false, spawnError: 'EACCES' };
  const result = verifyWitness(base, cand);
  assert.equal(result.verified, false);
  assert.equal(result.discriminates, false);
  assert.match(result.reason, /could not start.*EACCES/);
});

test('verifyWitness rejects shell launch failure exit 126 on base or cand', () => {
  const baseFail = verifyWitness(
    { status: 126, exitCode: 126, timedOut: false },
    { status: 1, exitCode: 1, timedOut: false }
  );
  assert.equal(baseFail.verified, false);
  assert.match(baseFail.reason, /shell launch failure.*126/);

  const candFail = verifyWitness(
    { status: 0, exitCode: 0, timedOut: false },
    { status: 126, exitCode: 126, timedOut: false }
  );
  assert.equal(candFail.verified, false);
  assert.match(candFail.reason, /shell launch failure.*126/);
});

test('verifyWitness rejects shell launch failure exit 127 on base or cand', () => {
  const baseFail = verifyWitness(
    { status: 127, exitCode: 127, timedOut: false },
    { status: 1, exitCode: 1, timedOut: false }
  );
  assert.equal(baseFail.verified, false);
  assert.match(baseFail.reason, /shell launch failure.*127/);

  const candFail = verifyWitness(
    { status: 0, exitCode: 0, timedOut: false },
    { status: 127, exitCode: 127, timedOut: false }
  );
  assert.equal(candFail.verified, false);
  assert.match(candFail.reason, /shell launch failure.*127/);
});

test('verifyWitness passes when base exits 0 and cand exits non-zero (non-126/127)', () => {
  const result = verifyWitness(
    { status: 0, exitCode: 0, timedOut: false },
    { status: 1, exitCode: 1, timedOut: false }
  );
  assert.equal(result.verified, true);
  assert.equal(result.discriminates, true);
  assert.equal(result.reason, 'ok');
});

test('discriminateWitness rejects ENOENT on candidate instead of treating as defect caught', () => {
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') return { status: 0, exitCode: 0, timedOut: false };
    return { status: null, exitCode: null, timedOut: false, spawnError: 'ENOENT' };
  };
  const result = discriminateWitness(
    { cmd: 'nonexistent-bin' },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 1, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.equal(result.verified, false);
  assert.match(result.reason, /could not start.*candidate.*ENOENT/);
});

test('discriminateWitness rejects exit 127 on candidate instead of treating as defect caught', () => {
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') return { status: 0, exitCode: 0, timedOut: false };
    return { status: 127, exitCode: 127, timedOut: false };
  };
  const result = discriminateWitness(
    { cmd: 'broken-cmd' },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 1, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.equal(result.verified, false);
  assert.match(result.reason, /shell launch failure.*candidate.*127/);
});

test('discriminateWitness rejects exit 126 on baseline', () => {
  const runFn = (_spec, dir) => {
    if (dir === 'baseline') return { status: 126, exitCode: 126, timedOut: false };
    return { status: 1, exitCode: 1, timedOut: false };
  };
  const result = discriminateWitness(
    { cmd: 'perm-denied-cmd' },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    { trials: 1, runFn }
  );
  assert.equal(result.discriminates, false);
  assert.equal(result.verified, false);
  assert.match(result.reason, /shell launch failure.*baseline.*126/);
});

test('verifyWitness and discriminateWitness reject null or undefined candidate exitCode', () => {
  const v = verifyWitness(
    { status: 0, exitCode: 0, timedOut: false },
    { status: null, exitCode: null, timedOut: false }
  );
  assert.equal(v.verified, false);
  assert.equal(v.discriminates, false);

  const d = discriminateWitness(
    { cmd: 'sig-killed-cmd' },
    { baselineDir: 'baseline', candidateDir: 'candidate' },
    {
      trials: 1,
      runFn: (_spec, dir) =>
        dir === 'baseline'
          ? { status: 0, exitCode: 0, timedOut: false }
          : { status: null, exitCode: null, timedOut: false },
    }
  );
  assert.equal(d.discriminates, false);
  assert.equal(d.verified, false);
  assert.match(d.reason, /did not exit with a positive status/);
});


