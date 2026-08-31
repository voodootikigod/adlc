// #641 — a clean/exhaustive verdict must not be reported unless a real
// independence source is configured (contract-derivation or a real
// independentApprovalFn). Without one, checkOracle's only path to
// independent:true is the candidate's own self-reported witnessSource, so a
// clean run proves nothing about whether a genuine defeat was missed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeVerdict } from '../lib/verdict.mjs';

test('clean dry-streak run, independenceConfigured:false → exit 1, refuses clean summary', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 5,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: false,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.summary, /no independence source configured — cannot certify absence of defeats/);
  assert.notEqual(result.summary, 'clean');
  assert.deepEqual(result.defeats, []);
  assert.equal(result.contractDefeats, 0);
  assert.equal(result.behavioralDefeats, 0);
  assert.equal(result.inconclusive, true);
});

test('clean dry-streak run, independenceConfigured:true → unchanged existing clean verdict', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 5,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: true,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'clean');
});

test('a real contract-derived defeat is reported identically regardless of independenceConfigured', () => {
  const defeats = [
    { id: 'cand-1', target: 'rails-guard', claimKind: 'freeze-integrity', witnessSource: 'contract-derived' },
  ];
  const withFalse = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 4,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: false,
  });
  const withTrue = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 4,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: true,
  });
  for (const result of [withFalse, withTrue]) {
    assert.equal(result.exitCode, 2);
    assert.equal(result.summary, 'gate-defeated');
    assert.equal(result.defeats.length, 1);
  }
});

test('a real behavioral defeat (REPORT path) is reported identically regardless of independenceConfigured', () => {
  const defeats = [
    { id: 'cand-1', target: 'hollow-test', claimKind: 'test-adequacy', witnessSource: 'independently-approved' },
  ];
  const withFalse = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 4,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: false,
  });
  const withTrue = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 4,
    strictBudget: false,
    failOnBehavioral: false,
    independenceConfigured: true,
  });
  for (const result of [withFalse, withTrue]) {
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary, 'behavioral-defeats-reported');
  }
});

test('bin/gate-fuzzing.mjs threads independenceConfigured: independentApprovalFn !== null into computeVerdict', () => {
  const binPath = fileURLToPath(new URL('../bin/gate-fuzzing.mjs', import.meta.url));
  const src = readFileSync(binPath, 'utf8');
  assert.match(src, /independenceConfigured:\s*independentApprovalFn\s*!==\s*null/);
});
