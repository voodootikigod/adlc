// §1.8 truth table tests: every row including post-setup sequencing (F11)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidate } from '../lib/classify.mjs';
import { defeatableGateDescriptor, cannedCandidate } from '../lib/controls.mjs';

// Helper to build a standard suite and baseline
function makeSetup(overrides = {}) {
  const gate = defeatableGateDescriptor();
  const candidate = cannedCandidate();
  const suite = [gate];
  const baseline = { dir: '/fake/baseline' };

  // Default stubs: gate passes, witness discriminates, oracle approves
  const runGateFn = overrides.runGateFn ?? (() => ({ exitCode: 0 }));
  const runWitnessFn = overrides.runWitnessFn ?? ((_spec, dir) => ({
    status: dir === baseline.dir ? 0 : 1,
    timedOut: false,
  }));
  const oracleFn = overrides.oracleFn ?? (() => ({ independent: true, source: 'contract-derived' }));

  return {
    candidate: { ...candidate, ...overrides.candidateOverrides },
    suite,
    baseline,
    runGateFn,
    runWitnessFn,
    oracleFn,
    witnessTrials: overrides.witnessTrials ?? 1,
    cloneDir: '/fake/clone',
  };
}

test('truth table row: valid + surface intersects + claim ok + gates pass + witness discriminates + independent → DEFEAT', () => {
  const setup = makeSetup();
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'DEFEAT');
});

test('truth table row: target gate exits 2 → caught', () => {
  const setup = makeSetup({
    runGateFn: () => ({ exitCode: 2 }),
  });
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'caught');
});

test('truth table row: target gate exits 1 → inconclusive', () => {
  const setup = makeSetup({
    runGateFn: () => ({ exitCode: 1 }),
  });
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'inconclusive');
});

test('truth table row: diff does not touch gate surface → out-of-scope', () => {
  const setup = makeSetup({
    candidateOverrides: {
      diff: 'diff --git a/unrelated/path.mjs b/unrelated/path.mjs\n+// noop',
    },
  });
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'out-of-scope');
});

test('truth table row: claimKind not in gate claims → wrong-claim', () => {
  const setup = makeSetup({
    candidateOverrides: {
      claimKind: 'test-adequacy', // defeatable gate only claims freeze-integrity
    },
  });
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'wrong-claim');
});

test('truth table row: witness not independent (oracle rejects) → unwitnessed', () => {
  const setup = makeSetup({
    oracleFn: () => ({ independent: false, source: 'unwitnessed', reason: 'self-authored' }),
  });
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'unwitnessed');
});

test('truth table row: witness flaky (mixed trials) → inconclusive', () => {
  let candidateCallCount = 0;
  const baseline = { dir: '/fake/baseline' };
  const setup = makeSetup({
    witnessTrials: 3,
    runWitnessFn: (_spec, dir) => {
      if (dir === baseline.dir) {
        // Baseline always passes
        return { status: 0, timedOut: false };
      }
      candidateCallCount++;
      // Second candidate trial passes (flaky!) — witness does NOT unanimously fail
      return { status: candidateCallCount === 2 ? 0 : 1, timedOut: false };
    },
  });
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'inconclusive');
});

test('unknown target gate in suite → invalid:target', () => {
  const setup = makeSetup({
    candidateOverrides: { target: 'nonexistent-gate' },
  });
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'invalid:target');
});

test('verdict includes witnessSource field for DEFEAT', () => {
  const setup = makeSetup();
  const verdict = classifyCandidate(setup.candidate, setup.suite, setup.baseline, setup);
  assert.equal(verdict.result, 'DEFEAT');
  assert.ok(verdict.witnessSource, 'DEFEAT must include witnessSource');
  assert.equal(verdict.witnessSource, 'contract-derived');
});
