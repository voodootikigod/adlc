// §3.1 — verdict() receiving defeats + stoppedBy + inconclusiveRounds
// Fix 4: inconclusiveRounds threaded through verdict
// Fix 5: behavioral-only defeats default to REPORT, not exit-2

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict } from '../lib/verdict.mjs';

test('no defeats + dry streak → exit 0 clean', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 5,
    strictBudget: false,
    failOnBehavioral: false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'clean');
});

test('contract-derived defeat → exit 2', () => {
  const defeats = [
    { id: 'cand-1', target: 'rails-guard', claimKind: 'freeze-integrity', witnessSource: 'contract-derived' },
  ];
  const result = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 4,
    strictBudget: false,
    failOnBehavioral: false,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.summary, 'gate-defeated');
});

test('behavioral-only defeat → exit 0 (REPORT) without --fail-on-behavioral', () => {
  const defeats = [
    { id: 'cand-1', target: 'hollow-test', claimKind: 'test-adequacy', witnessSource: 'independently-approved' },
  ];
  const result = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 4,
    strictBudget: false,
    failOnBehavioral: false,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'behavioral-defeats-reported');
  assert.equal(result.defeats.length, 1);
});

test('behavioral-only defeat + --fail-on-behavioral → exit 2', () => {
  const defeats = [
    { id: 'cand-1', target: 'hollow-test', claimKind: 'test-adequacy', witnessSource: 'independently-approved' },
  ];
  const result = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 4,
    strictBudget: false,
    failOnBehavioral: true,
  });
  assert.equal(result.exitCode, 2);
});

test('all rounds inconclusive + no defeats → inconclusive verdict', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'maxRounds',
    inconclusiveRounds: 5,
    rounds: 5,
    strictBudget: false,
    failOnBehavioral: false,
  });
  // All rounds were inconclusive and no clean dry streak
  assert.equal(result.summary, 'inconclusive');
  assert.equal(result.exitCode, 0); // exit 0 with loud warning in lenient mode
});

test('all rounds inconclusive + strictBudget → exit 1', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'maxRounds',
    inconclusiveRounds: 5,
    rounds: 5,
    strictBudget: true,
    failOnBehavioral: false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary, 'inconclusive');
});

test('partial inconclusive rounds with some dry rounds + no defeats → clean', () => {
  // 2 inconclusive rounds + 3 dry rounds → the dry streak governs
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'dry',
    inconclusiveRounds: 2,
    rounds: 5,
    strictBudget: false,
    failOnBehavioral: false,
  });
  // Had a genuine dry streak (stopped by 'dry'), some inconclusive but not all
  // This is clean since the dry streak was achieved
  assert.equal(result.exitCode, 0);
});

test('budget stop + strictBudget + no defeats → exit 1', () => {
  const result = computeVerdict({
    defeats: [],
    stoppedBy: 'budget',
    inconclusiveRounds: 0,
    rounds: 3,
    strictBudget: true,
    failOnBehavioral: false,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary, 'inconclusive');
});

test('mixed defeats: contract + behavioral → exit 2 (contract takes precedence)', () => {
  const defeats = [
    { id: 'cand-1', target: 'rails-guard', claimKind: 'freeze-integrity', witnessSource: 'contract-derived' },
    { id: 'cand-2', target: 'hollow-test', claimKind: 'test-adequacy', witnessSource: 'independently-approved' },
  ];
  const result = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 5,
    strictBudget: false,
    failOnBehavioral: false,
  });
  // Contract-derived defeat → exit 2 regardless
  assert.equal(result.exitCode, 2);
});

test('verdict includes witnessSource breakdown', () => {
  const defeats = [
    { id: 'cand-1', target: 'rails-guard', claimKind: 'freeze-integrity', witnessSource: 'contract-derived' },
    { id: 'cand-2', target: 'hollow-test', claimKind: 'test-adequacy', witnessSource: 'independently-approved' },
  ];
  const result = computeVerdict({
    defeats,
    stoppedBy: 'dry',
    inconclusiveRounds: 0,
    rounds: 5,
    strictBudget: false,
    failOnBehavioral: false,
  });
  assert.ok(result.contractDefeats >= 1);
  assert.ok(result.behavioralDefeats >= 1);
});
