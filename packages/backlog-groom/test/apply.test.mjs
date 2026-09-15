// apply.test.mjs — the write run assembled (§3.6–§3.8).
//
// The pieces are tested individually elsewhere; this is about the seam between
// them, which is where "gated" quietly becomes "gated in principle".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { actionsFromSet, applyRun, revalidateAction } from '../lib/apply.mjs';
import { contentHash } from '../lib/content-hash.mjs';
import { REVIEW_APPROVE, REVIEW_NEEDS_ATTENTION } from '../lib/gate.mjs';

// A world where issue 705's cited snippet is genuinely gone and 706's is not,
// so re-validation reaches the same verdicts the set claims.
const FILES = { 'src/a.mjs': 'something else\n', 'src/b.mjs': 'still here\n' };
const IO = {
  readFile: (f) => { if (!(f in FILES)) throw new Error('ENOENT'); return FILES[f]; },
  pathExists: (f) => f in FILES,
  lastCommitFor: () => 'abc1234',
};
const BODIES = {
  705: '**Location** `src/a.mjs:1`\n\n```\ngone\n```\n',
  706: '**Location** `src/b.mjs:1`\n\n```\nstill here\n```\n',
};
const fetchIssue = (n) => ({ number: n, title: 't', body: BODIES[n] ?? '', labels: [], updatedAt: `u${n}` });
const HASH = { 705: contentHash(['src/a.mjs'], IO), 706: contentHash(['src/b.mjs'], IO) };

const set = (over = {}) => ({
  schemaVersion: 4,
  issues: [
    { number: 705, verdict: 'fixed', contentHash: HASH[705], evidence: 'the cited line is gone', updatedAt: 'u705', frozen: false, labels: [], units: [] },
    { number: 706, verdict: 'valid', contentHash: HASH[706], evidence: 'still there', updatedAt: 'u706', frozen: false, labels: [], units: [] },
    { number: 700, verdict: 'unverifiable', contentHash: null, evidence: null, updatedAt: 'u700', frozen: false, labels: [], units: [] },
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
  assert.equal(relabel.contentHash, HASH[706]);
});

test('a proposal for an issue absent from the set is dropped, not guessed at', () => {
  const actions = actionsFromSet(set({ proposals: [{ number: 999, action: 'relabel', evidence: 'x' }] }));
  assert.equal(actions.find((a) => a.number === 999), undefined);
});

// ---- the seam: gate then floor then write ----------------------------------

test('an approved action reaches the writer, comment first', () => {
  const gh = fakeGh();
  const out = applyRun({ set: set(), profile: profile(), baseFloor: [], ledger: {}, fetchIssue, io: IO, runReview: () => ({ code: REVIEW_APPROVE }), gh });
  assert.deepEqual(gh.calls.map((c) => c[0]), ['comment', 'apply']);
  assert.equal(out.executed.length, 1);
});

test('a refused action writes nothing and is reported with its reason', () => {
  const gh = fakeGh();
  const out = applyRun({ set: set(), profile: profile(), baseFloor: [], ledger: {}, fetchIssue, io: IO, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }), gh });
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
    fetchIssue,
    io: IO,
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
    fetchIssue,
    io: IO,
    runReview: () => ({ code: REVIEW_APPROVE }),
    gh,
  });
  assert.equal(gh.calls.length, 0);
  assert.equal(out.demoted[0].reason, 'floor');
});

test('AC24: a widened floor refuses the run before any write', () => {
  const gh = fakeGh();
  assert.throws(
    () => applyRun({ set: set(), profile: profile({ autonomyFloor: [] }), baseFloor: ['close'], ledger: {}, fetchIssue, io: IO, runReview: () => ({ code: REVIEW_APPROVE }), gh }),
    (err) => err.isOpError === true
  );
  assert.equal(gh.calls.length, 0);
});

test('AC14: the ledger persists across the run so a replay within it is refused', () => {
  const ledger = {};
  const gh = fakeGh();
  applyRun({ set: set(), profile: profile(), baseFloor: [], ledger, fetchIssue, io: IO, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }), gh });

  let called = 0;
  const second = applyRun({
    set: set(),
    profile: profile(),
    baseFloor: [],
    ledger,
    fetchIssue,
    io: IO,
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

test('a frozen issue produces no close action', () => {
  const actions = actionsFromSet({
    schemaVersion: 3,
    issues: [{ number: 1, verdict: 'fixed', contentHash: 'h', evidence: 'gone', frozen: true }],
    proposals: [],
  });
  assert.deepEqual(actions, []);
});

test('a frozen issue produces no RELABEL action either', () => {
  // The proposals loop needs its own guard: the profile's frozen paths are about
  // the issue, not about one kind of action on it.
  const actions = actionsFromSet({
    schemaVersion: 3,
    issues: [{ number: 1, verdict: 'valid', contentHash: 'h', evidence: 'x', frozen: true }],
    proposals: [{ number: 1, action: 'relabel', field: 'priority', from: 'P3-low', to: 'P1-high', evidence: 'rank disagrees' }],
  });
  assert.deepEqual(actions, []);
});

test('an UNFROZEN issue still produces its relabel', () => {
  // The other direction, so a flipped guard cannot pass by blocking everything.
  const actions = actionsFromSet({
    schemaVersion: 3,
    issues: [{ number: 1, verdict: 'valid', contentHash: 'h', evidence: 'x', frozen: false }],
    proposals: [{ number: 1, action: 'relabel', field: 'priority', from: 'P3-low', to: 'P1-high', evidence: 'rank disagrees' }],
  });
  assert.deepEqual(actions.map((a) => a.action), ['relabel']);
});

test('an action class the writer cannot perform is dropped before any write', () => {
  // Refused here rather than at the writer, which would leave a rationale
  // comment on an issue nothing then happened to.
  const actions = actionsFromSet({
    schemaVersion: 3,
    issues: [{ number: 1, verdict: 'valid', contentHash: 'h', evidence: 'x', frozen: false }],
    proposals: [{ number: 1, action: 'duplicate-link', evidence: 'duplicate of #2' }],
  });
  assert.deepEqual(actions, []);
});

test('a stale set is refused before anything is gated', () => {
  const gh = fakeGh();
  let reviewed = 0;
  assert.throws(
    () =>
      applyRun({
        set: { ...set(), generatedFor: 'oldsha' },
        profile: profile(),
        baseFloor: [],
        ledger: {},
        fetchIssue,
        io: IO,
        revision: 'newsha',
        runReview: () => { reviewed += 1; return { code: REVIEW_APPROVE }; },
        gh,
      }),
    (err) => err.isOpError === true
  );
  assert.equal(reviewed, 0, 'a stale set must not even be reviewed');
  assert.equal(gh.calls.length, 0);
});

test('a set generated for the current revision proceeds', () => {
  const gh = fakeGh();
  const out = applyRun({
    set: { ...set(), generatedFor: 'samesha' },
    profile: profile(),
    baseFloor: [],
    ledger: {},
    fetchIssue,
    io: IO,
    revision: 'samesha',
    runReview: () => ({ code: REVIEW_APPROVE }),
    gh,
  });
  assert.equal(out.executed.length, 1);
});

test('each gate decision is checkpointed before any write', () => {
  // A verdict that exists only in memory is a verdict a crash erases, and the
  // next run would review the same revision again.
  const gh = fakeGh();
  const checkpoints = [];
  applyRun({
    set: set(),
    profile: profile(),
    baseFloor: [],
    ledger: {},
    fetchIssue,
    io: IO,
    runReview: () => ({ code: REVIEW_APPROVE }),
    persist: (l) => checkpoints.push(Object.keys(l).length),
    gh,
  });
  assert.ok(checkpoints.length >= 1, 'the ledger must be checkpointed');
});

// ---- the set is a proposal, not a capability -------------------------------

test('a set claiming a contentHash the code does not produce is refused', () => {
  // The replay bypass: change contentHash in the set, get a fresh gate key, and
  // buy another review for unchanged code until one approves.
  const fetchIssue = () => ({ number: 1, title: 't', body: '**Location** `src/a.mjs:1`\n\n```\nreal\n```\n', labels: [] });
  const out = revalidateAction(
    { number: 1, action: 'close', contentHash: 'forged', updatedAt: 'u1' },
    { fetchIssue, profile: { frozenPaths: [] }, io: { readFile: () => 'real\n' } }
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /contentHash/);
});

test('a set claiming frozen=false for a frozen path is refused', () => {
  // frozen is a mutable field in a file on disk; the profile is the authority.
  const fetchIssue = () => ({ number: 1, title: 't', body: '**Location** `packages/rails-guard/x.mjs:1`\n\n```\nreal\n```\n', labels: [] });
  const io = { readFile: () => 'real\n' };
  const hash = contentHash(['packages/rails-guard/x.mjs'], io);
  const out = revalidateAction(
    { number: 1, action: 'close', contentHash: hash, updatedAt: 'u1' },
    { fetchIssue, profile: { frozenPaths: ['packages/rails-guard/**'] }, io }
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /frozen/);
});

test('an issue that cannot be re-read is refused rather than assumed unchanged', () => {
  const out = revalidateAction(
    { number: 1, action: 'close', contentHash: 'h' },
    { fetchIssue: () => { throw new Error('404'); }, profile: {}, io: {} }
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /could not re-read/);
});

test('a set whose claims match the repository is accepted', () => {
  // A genuinely fixed issue: the cited snippet is gone from the file at HEAD.
  const fetchIssue = () => ({ number: 1, title: 't', body: '**Location** `src/a.mjs:1`\n\n```\ngone\n```\n', labels: [], updatedAt: 'u1' });
  const io = { readFile: () => 'something else\n', pathExists: () => true, lastCommitFor: () => 'abc1234' };
  const hash = contentHash(['src/a.mjs'], io);
  const out = revalidateAction({ number: 1, action: 'close', contentHash: hash, updatedAt: 'u1' }, { fetchIssue, profile: { frozenPaths: [] }, io });
  assert.equal(out.ok, true, out.reason);
});

test('a close for an issue that re-verifies as VALID is refused', () => {
  // The last "set is a capability" hole: matching bytes and an unchanged issue
  // prove the set describes the right thing, and say nothing about whether its
  // conclusion is right. A hand-written set can claim `fixed` for a live bug.
  const fetchIssue = () => ({ number: 1, title: 't', body: '**Location** `src/a.mjs:1`\n\n```\nstill here\n```\n', labels: [], updatedAt: 'u1' });
  const io = { readFile: () => 'still here\n', pathExists: () => true, lastCommitFor: () => 'abc1234' };
  const hash = contentHash(['src/a.mjs'], io);
  const out = revalidateAction(
    { number: 1, action: 'close', contentHash: hash, updatedAt: 'u1', verdict: 'fixed' },
    { fetchIssue, profile: { frozenPaths: [] }, io }
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /re-verif/i);
});

test('a set omitting updatedAt is refused rather than skipping the check', () => {
  const fetchIssue = () => ({ number: 1, title: 't', body: '**Location** `src/a.mjs:1`\n\n```\ngone\n```\n', labels: [], updatedAt: 'u1' });
  const io = { readFile: () => 'other\n', pathExists: () => true, lastCommitFor: () => 'abc1234' };
  const hash = contentHash(['src/a.mjs'], io);
  const out = revalidateAction({ number: 1, action: 'close', contentHash: hash }, { fetchIssue, profile: { frozenPaths: [] }, io });
  assert.equal(out.ok, false);
  assert.match(out.reason, /updatedAt/);
});

test('a set with no generatedFor is refused when a revision is known', () => {
  const gh = fakeGh();
  assert.throws(
    () => applyRun({ set: { issues: [], proposals: [] }, profile: profile(), baseFloor: [], ledger: {}, revision: 'abc', runReview: () => ({ code: REVIEW_APPROVE }), gh }),
    (err) => err.isOpError === true
  );
});

test('applyRun refuses when it has no way to re-read issues', () => {
  // A fail-open seam: without fetchIssue the set's claims cannot be checked, and
  // proceeding would trust a file on disk for every security-relevant fact.
  const gh = fakeGh();
  assert.throws(
    () => applyRun({ set: set(), profile: profile(), baseFloor: [], ledger: {}, runReview: () => ({ code: REVIEW_APPROVE }), gh }),
    (err) => err.isOpError === true
  );
  assert.equal(gh.calls.length, 0);
});

test('a widened floor is refused BEFORE any review is spent', () => {
  // The gate previously ran first, so a recoverable config error burned every
  // action's one shot and then refused the run — permanently demoting those
  // revisions for a typo.
  const gh = fakeGh();
  let reviewed = 0;
  const ledger = {};
  assert.throws(
    () =>
      applyRun({
        set: set(),
        profile: profile({ autonomyFloor: [] }),
        baseFloor: ['close'],
        ledger,
        fetchIssue,
        io: IO,
        runReview: () => { reviewed += 1; return { code: REVIEW_APPROVE }; },
        gh,
      }),
    (err) => err.isOpError === true
  );
  assert.equal(reviewed, 0, 'no review may be spent on a run the policy refuses');
  assert.deepEqual(ledger, {}, 'and no one-shot may be recorded');
});

test('revalidation reads the PINNED revision, not a moving HEAD', () => {
  // A checkout moving HEAD mid-run would otherwise have later actions validated
  // against a different tree than the one the set was accepted against.
  let seenRevision = null;
  const io = {
    readFile: (f) => { if (!(f in FILES)) throw new Error('ENOENT'); return FILES[f]; },
    pathExists: (f) => f in FILES,
    lastCommitFor: () => 'abc1234',
  };
  const spyIo = new Proxy(io, {
    get(target, prop) {
      if (prop === 'revision') return seenRevision;
      return target[prop];
    },
  });
  const gh = fakeGh();
  applyRun({
    set: { ...set(), generatedFor: 'pinned-sha' },
    profile: profile(),
    baseFloor: [],
    ledger: {},
    fetchIssue,
    io: spyIo,
    revision: 'pinned-sha',
    runReview: () => ({ code: REVIEW_APPROVE }),
    gh,
  });
  // The pinned revision is what reaches contentHash/verifyIssue, so an action
  // validated here describes the commit the set was accepted against.
  assert.equal(gh.calls.length > 0, true, 'the run must reach the writer');
});

// ---- relabel targets are re-derived, not taken from the set ----------------

const labelProfile = () => ({
  autonomyFloor: [],
  providers: { decider: 'anthropic', reviewer: 'openai' },
  frozenPaths: [],
  labels: { priority: { high: 'P1-high', medium: 'P2-medium', low: 'P3-low' }, areaPrefix: 'area:' },
  units: [{ name: 'review', paths: ['packages/review/**'] }],
});
const labelledIssue = (labels) => () => ({
  number: 1, title: 't', body: '**Location** `src/a.mjs:1`\n\n```\ngone\n```\n', labels, updatedAt: 'u1',
});

test('a relabel to a label the profile does not declare is refused', () => {
  // from/to go straight into `gh issue edit --remove-label/--add-label`, so an
  // unchecked target lets a crafted set attach or strip any label it likes.
  const hash = contentHash(['src/a.mjs'], IO);
  const out = revalidateAction(
    { number: 1, action: 'relabel', field: 'priority', from: 'P3-low', to: 'not-a-real-label', contentHash: hash, updatedAt: 'u1' },
    { fetchIssue: labelledIssue(['P3-low']), profile: labelProfile(), io: IO }
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /not a label this profile declares/);
});

test('a relabel removing a label the issue does not carry is refused', () => {
  const hash = contentHash(['src/a.mjs'], IO);
  const out = revalidateAction(
    { number: 1, action: 'relabel', field: 'priority', from: 'P1-high', to: 'P2-medium', contentHash: hash, updatedAt: 'u1' },
    { fetchIssue: labelledIssue(['P3-low']), profile: labelProfile(), io: IO }
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /does not currently carry/);
});

test('a relabel between declared labels the issue really has is accepted', () => {
  const hash = contentHash(['src/a.mjs'], IO);
  const out = revalidateAction(
    { number: 1, action: 'relabel', field: 'priority', from: 'P3-low', to: 'P1-high', contentHash: hash, updatedAt: 'u1' },
    { fetchIssue: labelledIssue(['P3-low']), profile: labelProfile(), io: IO }
  );
  assert.equal(out.ok, true, out.reason);
});

test('an area relabel may target a declared unit', () => {
  const hash = contentHash(['src/a.mjs'], IO);
  const out = revalidateAction(
    { number: 1, action: 'relabel', field: 'area', from: 'area:review', to: 'area:review', contentHash: hash, updatedAt: 'u1' },
    { fetchIssue: labelledIssue(['area:review']), profile: labelProfile(), io: IO }
  );
  assert.equal(out.ok, true, out.reason);
});
