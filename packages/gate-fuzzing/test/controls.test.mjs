// FIRST RED — §5.1/5.2: defeatable→DEFEAT, sound→never DEFEAT
// Tests that the classifier correctly handles the control stubs:
//   - A known-defeatable gate + canned candidate → verdict DEFEAT
//   - A sound (fail-closed) gate + canned candidate → verdict NOT DEFEAT

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidate } from '../lib/classify.mjs';
import {
  defeatableGateDescriptor,
  soundGateDescriptor,
  cannedCandidate,
} from '../lib/controls.mjs';

// The defeatable stub: a gate that trivially exits 0 even when called against
// a candidate that violates its declared claim (simulates a base-ref blind spot).
// Canned candidate: a structured candidate that exploits that hole.
// Expected: classifyCandidate → DEFEAT

test('classifier flags defeatable stub as DEFEAT', async () => {
  const candidate = cannedCandidate();
  const gateDesc = defeatableGateDescriptor();
  const soundGate = soundGateDescriptor();

  // The defeatable gate must be in the suite, sound gate also included
  const suite = [gateDesc, soundGate];
  const baseline = { dir: '/fake/baseline' };

  // Use a stubbed runGateFn: defeatable gate always exits 0 (passes candidate),
  // sound gate also exits 0 (passes candidate - it's in the suite but not the target)
  const runGateFn = (gateName, _cloneDir, _setupCmds) => {
    // All gates exit 0 for candidate (passes every gate — condition 2)
    return { exitCode: 0 };
  };

  // The witness for this candidate discriminates (passes on baseline, fails on candidate)
  const runWitnessFn = (witnessSpec, dir) => {
    // On baseline dir: exit 0 (passes)
    // On candidate dir: exit 1 (fails — defect observable)
    if (dir === baseline.dir) return { status: 0, timedOut: false };
    return { status: 1, timedOut: false };
  };

  // The oracle: this is a contract-derived witness (fix 3 says we have (a) and (b) only)
  // For the control test, we mark the witness as contract-derived so it clears independence
  const oracleResult = { independent: true, source: 'contract-derived' };

  const verdict = classifyCandidate(candidate, suite, baseline, {
    runGateFn,
    runWitnessFn,
    oracleFn: () => oracleResult,
    witnessTrials: 1,
    cloneDir: '/fake/clone',
  });

  assert.equal(verdict.result, 'DEFEAT', `Expected DEFEAT, got ${verdict.result}: ${verdict.reason}`);
  assert.equal(verdict.target, candidate.target);
});

test('classifier does NOT report DEFEAT for sound stub', async () => {
  const candidate = cannedCandidate();
  const soundGate = soundGateDescriptor();
  // Override target to point to the sound gate
  const candidateVsSound = { ...candidate, target: soundGate.name };
  const suite = [soundGate];
  const baseline = { dir: '/fake/baseline' };

  // Sound gate catches the candidate — exits 2 (caught)
  const runGateFn = (gateName) => {
    if (gateName === soundGate.name) return { exitCode: 2 };
    return { exitCode: 0 };
  };

  const runWitnessFn = (_spec, dir) => {
    if (dir === baseline.dir) return { status: 0, timedOut: false };
    return { status: 1, timedOut: false };
  };

  const verdict = classifyCandidate(candidateVsSound, suite, baseline, {
    runGateFn,
    runWitnessFn,
    oracleFn: () => ({ independent: true, source: 'contract-derived' }),
    witnessTrials: 1,
    cloneDir: '/fake/clone',
  });

  assert.notEqual(verdict.result, 'DEFEAT', `Sound gate should not be defeated, got ${verdict.result}`);
  assert.equal(verdict.result, 'caught');
});

test('classifier does NOT report DEFEAT when candidate is out of gate surface', () => {
  const candidate = cannedCandidate();
  // Modify candidate diff to touch a file outside the gate's surface
  const outOfScopeCandidate = {
    ...candidate,
    diff: 'diff --git a/completely/different/file.mjs b/completely/different/file.mjs\n+// change',
  };
  const gateDesc = defeatableGateDescriptor();
  const suite = [gateDesc];
  const baseline = { dir: '/fake/baseline' };

  const runGateFn = () => ({ exitCode: 0 });
  const runWitnessFn = (_spec, dir) => {
    if (dir === baseline.dir) return { status: 0, timedOut: false };
    return { status: 1, timedOut: false };
  };

  const verdict = classifyCandidate(outOfScopeCandidate, suite, baseline, {
    runGateFn,
    runWitnessFn,
    oracleFn: () => ({ independent: true, source: 'contract-derived' }),
    witnessTrials: 1,
    cloneDir: '/fake/clone',
  });

  assert.notEqual(verdict.result, 'DEFEAT', `Out-of-scope candidate should not be DEFEAT`);
  assert.equal(verdict.result, 'out-of-scope');
});
