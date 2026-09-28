// apply-authority.test.mjs — what the write run requires before it spends a
// review, and what a set may ask it to do.
//
// REVISION: a set describes one commit. The run that cannot establish its own
// commit must refuse, not skip the staleness check and read an unpinned HEAD.
//
// CLOSES: a close is derived from a re-verified `fixed` verdict and nothing
// else. The set's `proposals[]` is caller-editable, and anything it carries into
// the gate key (a `field` string) is a fresh one-shot slot — so a close is never
// taken from there.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { actionsFromSet, applyRun } from '../lib/apply.mjs';
import { contentHash } from '../lib/content-hash.mjs';
import { REVIEW_APPROVE, REVIEW_NEEDS_ATTENTION } from '../lib/gate.mjs';

const TEST_KEY = 'unit-test-ledger-key-0123456789ab';
const REV = 'c'.repeat(40);
const FILES = { 'src/a.mjs': 'something else\n' };
const IO = {
  readFile: (f) => { if (!(f in FILES)) throw new Error('ENOENT'); return FILES[f]; },
  pathKind: (f) => (f in FILES ? 'blob' : null),
  lastCommitFor: () => 'abc1234',
};
const BODY = '**Location** `src/a.mjs:1`\n\n```\ngone\n```\n';
const fetchIssue = (n) => ({ number: n, title: 't', body: BODY, labels: [], updatedAt: 'u1' });
const HASH = contentHash(['src/a.mjs'], IO);
const POLICY = { autonomyFloor: [], providers: { decider: 'anthropic', reviewer: 'openai' } };

const set = (over = {}) => ({
  schemaVersion: 4,
  generatedFor: REV,
  issues: [{ number: 1, verdict: 'fixed', contentHash: HASH, evidence: 'gone', updatedAt: 'u1', frozen: false, labels: [], units: [] }],
  proposals: [],
  ...over,
});

function gh() {
  const calls = [];
  return { calls, comments: () => [], comment: (n) => calls.push(['comment', n]), apply: (n, a) => calls.push(['apply', n, a]) };
}

function run(over = {}) {
  const writer = gh();
  let reviews = 0;
  const out = applyRun({
    key: TEST_KEY, set: set(), profile: POLICY, basePolicy: POLICY, baseFloor: [], ledger: {},
    fetchIssue, io: IO, gh: writer, revision: REV,
    runReview: () => { reviews += 1; return { code: REVIEW_APPROVE }; },
    ...over,
  });
  return { out, writer, reviews: () => reviews };
}

// ---- revision --------------------------------------------------------------

for (const revision of [null, undefined, '', 'HEAD', 'not-a-sha', 'c'.repeat(39)]) {
  test(`a revision of ${JSON.stringify(revision)} refuses before any review or write`, () => {
    const writer = gh();
    let reviews = 0;
    assert.throws(
      () => applyRun({
        key: TEST_KEY, set: set(), profile: POLICY, basePolicy: POLICY, baseFloor: [], ledger: {},
        fetchIssue, io: IO, gh: writer, revision,
        runReview: () => { reviews += 1; return { code: REVIEW_APPROVE }; },
      }),
      (err) => err.isOpError === true && /revision/.test(err.message),
    );
    assert.equal(reviews, 0);
    assert.deepEqual(writer.calls, []);
  });
}

test('a commit-shaped revision matching the set proceeds', () => {
  const { out, writer } = run();
  assert.equal(out.executed.length, 1);
  assert.deepEqual(writer.calls.map((c) => c[0]), ['comment', 'apply']);
});

test('a sha-256 repository revision is accepted too', () => {
  const rev = 'd'.repeat(64);
  const { out } = run({ revision: rev, set: set({ generatedFor: rev }) });
  assert.equal(out.executed.length, 1);
});

// ---- closes come from the verdict only -------------------------------------

test('a close in proposals[] is not an action', () => {
  const actions = actionsFromSet(set({ issues: [{ ...set().issues[0], verdict: 'valid' }], proposals: [{ number: 1, action: 'close', field: 'again', evidence: 'x' }] }));
  assert.deepEqual(actions, []);
});

test('a close re-proposed under any field string gets no second review', () => {
  const ledger = {};
  const first = run({ ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }) });
  assert.equal(first.out.executed.length, 0);

  let reviews = 0;
  for (const field of ['again', 'and-again', null]) {
    const writer = gh();
    applyRun({
      key: TEST_KEY, set: set({ proposals: [{ number: 1, action: 'close', field, evidence: 'x' }] }),
      profile: POLICY, basePolicy: POLICY, baseFloor: [], ledger, fetchIssue, io: IO, gh: writer, revision: REV,
      runReview: () => { reviews += 1; return { code: REVIEW_APPROVE }; },
    });
    assert.deepEqual(writer.calls, [], `field ${JSON.stringify(field)} must not buy a write`);
  }
  assert.equal(reviews, 0, 'one close at one revision gets one review');
  assert.deepEqual(Object.keys(ledger).filter((k) => k.startsWith('1:close')), [`1:close:${HASH}`]);
});

test('a derived close and a proposed close in ONE set are one review, not two', () => {
  let reviews = 0;
  const writer = gh();
  applyRun({
    key: TEST_KEY, set: set({ proposals: [{ number: 1, action: 'close', field: 'x', evidence: 'x' }] }),
    profile: POLICY, basePolicy: POLICY, baseFloor: [], ledger: {}, fetchIssue, io: IO, gh: writer, revision: REV,
    runReview: () => { reviews += 1; return { code: REVIEW_APPROVE }; },
  });
  assert.equal(reviews, 1);
  assert.equal(writer.calls.filter((c) => c[0] === 'apply').length, 1);
});
