// apply.test.mjs — the write run assembled (§3.6–§3.8).
//
// The pieces are tested individually elsewhere; this is about the seam between
// them, which is where "gated" quietly becomes "gated in principle".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { actionsFromSet, applyRun } from '../lib/apply.mjs';
import { REVIEW_APPROVE, REVIEW_NEEDS_ATTENTION } from '../lib/gate.mjs';

const set = (over = {}) => ({
  schemaVersion: 2,
  issues: [
    { number: 705, verdict: 'fixed', contentHash: 'h705', evidence: 'the cited line is gone', labels: [], units: [] },
    { number: 706, verdict: 'valid', contentHash: 'h706', evidence: 'still there', labels: [], units: [] },
    { number: 700, verdict: 'unverifiable', contentHash: null, evidence: null, labels: [], units: [] },
  ],
  proposals: [],
  ...over,
});

const profile = (over = {}) => ({
  autonomyFloor: [],
  providers: { decider: 'anthropic', reviewer: 'openai' },
  ...over,
});

function fakeGh() {
  const calls = [];
  return {
    calls,
    comments: () => [],
    comment: (n, b) => calls.push(['comment', n, b]),
    apply: (n, a) => calls.push(['apply', n, a]),
  };
}

// ---- which proposals become actions ----------------------------------------

test('only a fixed verdict proposes a close', () => {
  const actions = actionsFromSet(set());
  assert.deepEqual(actions.map((a) => [a.number, a.action]), [[705, 'close']]);
});

test('an issue with no contentHash yields no action at all', () => {
  // §2.2 leaves it with no revision to bind a verdict to, so it can be neither
  // gated nor replay-protected. Silently acting on it would be acting on the one
  // class of issue the gate cannot cover.
  const actions = actionsFromSet({
    schemaVersion: 2,
    issues: [{ number: 700, verdict: 'fixed', contentHash: null, evidence: 'x' }],
    proposals: [],
  });
  assert.deepEqual(actions, []);
});

test('relabel proposals carry the issue contentHash so they can be gated', () => {
  const actions = actionsFromSet(
    set({ proposals: [{ number: 706, action: 'relabel', field: 'priority', from: 'P3-low', to: 'P1-high', evidence: 'rank disagrees' }] })
  );
  const relabel = actions.find((a) => a.action === 'relabel');
  assert.equal(relabel.contentHash, 'h706');
});

test('a proposal for an issue absent from the set is dropped, not guessed at', () => {
  const actions = actionsFromSet(set({ proposals: [{ number: 999, action: 'relabel', evidence: 'x' }] }));
  assert.equal(actions.find((a) => a.number === 999), undefined);
});

// ---- the seam: gate then floor then write ----------------------------------

test('an approved action reaches the writer, comment first', () => {
  const gh = fakeGh();
  const out = applyRun({ set: set(), profile: profile(), baseFloor: [], ledger: {}, runReview: () => ({ code: REVIEW_APPROVE }), gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
  assert.equal(out.executed.length, 1);
});

test('a refused action writes nothing and is reported with its reason', () => {
  const gh = fakeGh();
  const out = applyRun({ set: set(), profile: profile(), baseFloor: [], ledger: {}, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }), gh });
  assert.equal(gh.calls.length, 0);
  assert.equal(out.executed.length, 0);
  assert.equal(out.gateDemotions.length, 1);
  assert.match(out.gateDemotions[0].reason, /material finding/);
});

test('AC8: with no distinct provider nothing is written and the reviewer is never called', () => {
  const gh = fakeGh();
  let called = 0;
  const out = applyRun({
    set: set(),
    profile: profile({ providers: { decider: 'anthropic' } }),
    baseFloor: [],
    ledger: {},
    runReview: () => { called += 1; return { code: REVIEW_APPROVE }; },
    gh,
  });
  assert.equal(called, 0);
  assert.equal(gh.calls.length, 0);
  assert.equal(out.executed.length, 0);
  assert.equal(out.proposed, 1, 'the run still reports what it would have done');
});

test('the floor outranks an approve', () => {
  const gh = fakeGh();
  const out = applyRun({
    set: set(),
    profile: profile({ autonomyFloor: ['close'] }),
    baseFloor: ['close'],
    ledger: {},
    runReview: () => ({ code: REVIEW_APPROVE }),
    gh,
  });
  assert.equal(gh.calls.length, 0);
  assert.equal(out.demoted[0].reason, 'floor');
});

test('AC24: a widened floor refuses the run before any write', () => {
  const gh = fakeGh();
  assert.throws(
    () => applyRun({ set: set(), profile: profile({ autonomyFloor: [] }), baseFloor: ['close'], ledger: {}, runReview: () => ({ code: REVIEW_APPROVE }), gh }),
    (err) => err.isOpError === true
  );
  assert.equal(gh.calls.length, 0);
});

test('AC14: the ledger persists across the run so a replay within it is refused', () => {
  const ledger = {};
  const gh = fakeGh();
  applyRun({ set: set(), profile: profile(), baseFloor: [], ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }), gh });

  let called = 0;
  const second = applyRun({
    set: set(),
    profile: profile(),
    baseFloor: [],
    ledger,
    runReview: () => { called += 1; return { code: REVIEW_APPROVE }; },
    gh,
  });
  assert.equal(called, 0, 'a second run must not re-review the same revision');
  assert.equal(second.executed.length, 0);
});

test('non-string evidence is serialised rather than passed through as an object', () => {
  // The evidence reaches a GitHub comment body. An object interpolated into a
  // template would render as [object Object] — an evidence trail that says
  // nothing, on an issue that is about to go quiet.
  const actions = actionsFromSet({
    schemaVersion: 2,
    issues: [{ number: 1, verdict: 'fixed', contentHash: 'h', evidence: { lines: ['a'], commit: 'abc' } }],
    proposals: [],
  });
  assert.equal(typeof actions[0].evidence, 'string');
  assert.match(actions[0].evidence, /abc/);
  assert.ok(!actions[0].evidence.includes('[object Object]'));
});

test('string evidence is passed through unchanged, not re-encoded', () => {
  const actions = actionsFromSet({
    schemaVersion: 2,
    issues: [{ number: 1, verdict: 'fixed', contentHash: 'h', evidence: 'the cited line is gone' }],
    proposals: [],
  });
  assert.equal(actions[0].evidence, 'the cited line is gone');
});

test('absent evidence becomes an explicit null string, never undefined', () => {
  const actions = actionsFromSet({
    schemaVersion: 2,
    issues: [{ number: 1, verdict: 'fixed', contentHash: 'h' }],
    proposals: [],
  });
  assert.equal(typeof actions[0].evidence, 'string');
});
