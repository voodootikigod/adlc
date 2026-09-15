// gate.test.mjs — the adversarial gate (spec §3.6): AC7, AC8, AC14, AC25.
//
// The gate's job is to be unbypassable, so most of what follows is about the
// ways a determined caller gets a second opinion it likes better: replaying a
// reworded artifact, reviewing with itself, or reading an error as an approve.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_CONFIDENCE,
  makeReviewRunner,
  REVIEW_APPROVE,
  REVIEW_NEEDS_ATTENTION,
  reviewerPair,
  gateKey,
  gateAction,
  reviewArgv,
  buildActionArtifact,
  ledgerApproves,
} from '../lib/gate.mjs';

const action = (over = {}) => ({ number: 7, action: 'close', contentHash: 'abc123', evidence: 'the cited lines are gone', ...over });
const profile = (over = {}) => ({ providers: { decider: 'anthropic', reviewer: 'openai' }, ...over });

// ---- the reviewer must differ from the decider (AC8, AC25) -----------------

test('AC25: providers.decider absent means the distinct-reviewer rule is unsatisfiable', () => {
  // The core cannot compare against something it was never told. Guessing a
  // decider would let the rule pass on an assumption nobody made.
  const pair = reviewerPair({ providers: { reviewer: 'openai' } });
  assert.equal(pair.ok, false);
  assert.match(pair.reason, /decider/);
});

test('AC8: an absent reviewer means no distinct provider is available', () => {
  const pair = reviewerPair({ providers: { decider: 'anthropic' } });
  assert.equal(pair.ok, false);
  assert.match(pair.reason, /reviewer/);
});

test('AC8: a reviewer identical to the decider is not a second opinion', () => {
  // Same family reviewing itself shares the blind spots cross-model review
  // exists to catch, so it is refused rather than counted.
  const pair = reviewerPair({ providers: { decider: 'openai', reviewer: 'openai' } });
  assert.equal(pair.ok, false);
  assert.match(pair.reason, /distinct/i);
});

test('a decider and a distinct reviewer are accepted', () => {
  const pair = reviewerPair(profile());
  assert.equal(pair.ok, true);
  assert.equal(pair.decider, 'anthropic');
  assert.equal(pair.reviewer, 'openai');
});

test('AC8: with no distinct provider every action demotes, and nothing throws', () => {
  // The run must still complete: the read-only half stays useful when the
  // reviewer is unavailable, which is routine (quota, offline, one provider
  // configured). Demote, report, carry on.
  const ledger = {};
  const out = gateAction({ action: action(), profile: { providers: {} }, ledger, runReview: () => { throw new Error('must not be called'); } });
  assert.equal(out.verdict, 'demote');
  assert.match(out.reason, /provider/i);
});

// ---- the argv the reviewer is actually invoked with -------------------------

test('the review runs in artifact mode at the lowered confidence floor', () => {
  // 0.5 yields hollow approves in artifact mode because grounding halves every
  // finding's confidence — an exit 0 that reviewed nothing. The threshold is
  // part of the contract, so it is asserted rather than trusted.
  const argv = reviewArgv({ artifactPath: '/tmp/a.md', reviewer: 'openai' });
  assert.ok(argv.includes('--input'));
  assert.ok(argv.includes('/tmp/a.md'));
  assert.ok(argv.includes('--min-confidence'));
  assert.equal(argv[argv.indexOf('--min-confidence') + 1], String(MIN_CONFIDENCE));
  assert.equal(MIN_CONFIDENCE, 0.3);
  assert.equal(argv[argv.indexOf('--provider') + 1], 'openai');
});

test('exactly one artifact is reviewed per invocation', () => {
  // Batched artifacts do not converge, and a batched verdict is not
  // attributable to a specific action.
  const argv = reviewArgv({ artifactPath: '/tmp/a.md', reviewer: 'openai' });
  assert.equal(argv.filter((a) => a === '--input').length, 1);
});

// ---- verdict mapping: only exit 0 is an approve ----------------------------

test('AC7: an approve licenses the action and is recorded against the revision', () => {
  const ledger = {};
  const out = gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  assert.equal(out.verdict, 'approve');
  assert.ok(ledger[gateKey(action())], 'the verdict must be recorded against (issue, contentHash)');
});

test('AC7: needs-attention demotes to a proposal', () => {
  const ledger = {};
  const out = gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }) });
  assert.equal(out.verdict, 'demote');
});

test('AC7: a reviewer ERROR demotes — an error is not an approve', () => {
  // Exit 1 means the review could not complete. Reading "not blocked" as
  // "approved" is the single cheapest way to turn an unavailable reviewer into
  // a rubber stamp.
  const ledger = {};
  const out = gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: 1 }) });
  assert.equal(out.verdict, 'demote');
  assert.match(out.reason, /error|could not/i);
});

test('AC7: a thrown reviewer demotes rather than propagating', () => {
  const ledger = {};
  const out = gateAction({
    action: action(),
    profile: profile(),
    ledger,
    runReview: () => { throw new Error('spawn ENOENT'); },
  });
  assert.equal(out.verdict, 'demote');
});

test('AC7: an unrecognised exit code demotes', () => {
  const ledger = {};
  const out = gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: 37 }) });
  assert.equal(out.verdict, 'demote');
});

// ---- AC14: one shot, enforced in the core ----------------------------------

test('AC14: a second gate attempt for the same (issue, contentHash) is refused', () => {
  // The failure this prevents: a wrapper that did not like the answer rewords
  // the artifact and asks again until it gets an approve. Re-asking is the
  // bypass, so re-asking is what gets refused — by code, not by instructions.
  const ledger = {};
  const first = gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }) });
  assert.equal(first.verdict, 'demote');

  let called = 0;
  const second = gateAction({
    action: action({ evidence: 'a much more persuasive retelling' }),
    profile: profile(),
    ledger,
    runReview: () => { called += 1; return { code: REVIEW_APPROVE }; },
  });
  assert.equal(called, 0, 'the reviewer must not be consulted a second time for the same revision');
  assert.equal(second.verdict, 'demote');
  assert.match(second.reason, /already/i);
});

test('AC14: a replay cannot upgrade a prior demote, even to the same verdict', () => {
  const ledger = {};
  gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }) });
  const replay = gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  assert.equal(replay.verdict, 'demote');
});

test('AC14: a DIFFERENT contentHash is a different revision and may be reviewed', () => {
  // The refusal is about re-asking for the same code, not about the issue ever
  // being reviewable again. Code changing is the legitimate reason to re-ask.
  const ledger = {};
  gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }) });
  const out = gateAction({ action: action({ contentHash: 'def456' }), profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  assert.equal(out.verdict, 'approve');
});

test('AC14: an action with no contentHash cannot be gated at all', () => {
  // §2.2: an issue with no referenced paths has no contentHash. Without one
  // there is no revision to bind a verdict to, so a replay would be undetectable
  // — the one-shot guarantee simply does not exist for it.
  const ledger = {};
  const out = gateAction({ action: action({ contentHash: null }), profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  assert.equal(out.verdict, 'demote');
  assert.match(out.reason, /contentHash|revision/i);
});

test('the ledger records the verdict, the reviewer and the revision', () => {
  const ledger = {};
  gateAction({ action: action(), profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  const entry = ledger[gateKey(action())];
  assert.equal(entry.verdict, 'approve');
  assert.equal(entry.reviewer, 'openai');
  assert.equal(entry.decider, 'anthropic');
  assert.equal(entry.contentHash, 'abc123');
});

// ---- the external exit contract, pinned numerically ------------------------

test('the reviewer exit codes are pinned to adversarial-review\'s documented contract', () => {
  // These are not ours to choose: 0 approve / 2 needs-attention / 1 error is the
  // reviewer's published contract. Referring to them only through the constants
  // would let either drift to a value the reviewer never emits, and every test
  // that passes the constant symbolically would keep passing.
  assert.equal(REVIEW_APPROVE, 0);
  assert.equal(REVIEW_NEEDS_ATTENTION, 2);
});

test('a literal exit 2 demotes and a literal exit 0 approves', () => {
  // The same contract exercised by VALUE rather than by constant, so a drifted
  // constant is caught by behaviour and not only by its own assertion.
  const l1 = {};
  assert.equal(gateAction({ action: action(), profile: profile(), ledger: l1, runReview: () => ({ code: 0 }) }).verdict, 'approve');
  const l2 = {};
  assert.equal(gateAction({ action: action(), profile: profile(), ledger: l2, runReview: () => ({ code: 2 }) }).verdict, 'demote');
});

// ---- makeReviewRunner: the spawn branches, out of the binary ----------------

test('a spawn error is a thrown non-approve, never a verdict', () => {
  const run = makeReviewRunner({ spawn: () => ({ error: new Error('ENOENT'), status: null }), artifactPath: '/tmp/a', reviewer: 'openai' });
  assert.throws(run, /did not run|ENOENT/);
});

test('a null status is a thrown non-approve — null is not an exit code', () => {
  const run = makeReviewRunner({ spawn: () => ({ status: null }), artifactPath: '/tmp/a', reviewer: 'openai' });
  assert.throws(run, /did not run/);
});

test('an undefined status is a thrown non-approve too', () => {
  const run = makeReviewRunner({ spawn: () => ({}), artifactPath: '/tmp/a', reviewer: 'openai' });
  assert.throws(run, /did not run/);
});

test('a real exit status is passed through as the code', () => {
  const run = makeReviewRunner({ spawn: () => ({ status: 2 }), artifactPath: '/tmp/a', reviewer: 'openai' });
  assert.deepEqual(run(), { code: 2 });
});

test('the runner spawns adversarial-review with the artifact and reviewer it was given', () => {
  let seen = null;
  const run = makeReviewRunner({ spawn: (cmd, argv) => { seen = { cmd, argv }; return { status: 0 }; }, artifactPath: '/tmp/set.json', reviewer: 'openai' });
  run();
  assert.equal(seen.cmd, 'adversarial-review');
  assert.ok(seen.argv.includes('/tmp/set.json'));
  assert.equal(seen.argv[seen.argv.indexOf('--provider') + 1], 'openai');
});

test('a non-object providers value is treated as no providers, not indexed into', () => {
  // `typeof null === 'object'` and an array is an object too. A loosened guard
  // would index into either and silently produce undefined providers, which then
  // read as "not declared" — the right answer reached by luck rather than by
  // the check.
  for (const bad of [null, ['openai'], 'openai', 7]) {
    const pair = reviewerPair({ providers: bad });
    assert.equal(pair.ok, false, `providers=${JSON.stringify(bad)} must not resolve a pair`);
  }
});

test('an array providers value cannot smuggle a decider through', () => {
  const providers = [];
  providers.decider = 'anthropic';
  providers.reviewer = 'openai';
  assert.equal(reviewerPair({ providers }).ok, false);
});

// ---- one artifact per action (§3.6) ----------------------------------------

test('the artifact describes exactly one action, bound to its revision', () => {
  const art = buildActionArtifact(action());
  assert.match(art, /#7\b/);
  assert.match(art, /close/);
  assert.match(art, /abc123/, 'the artifact must name the revision the verdict binds to');
  assert.match(art, /the cited lines are gone/);
});

test('the artifact carries the relabel fields when there are any', () => {
  const art = buildActionArtifact({ number: 9, action: 'relabel', contentHash: 'h', field: 'priority', from: 'P3-low', to: 'P1-high', evidence: 'rank disagrees' });
  assert.match(art, /priority/);
  assert.match(art, /P3-low/);
  assert.match(art, /P1-high/);
});

test('non-string evidence is rendered readably, not as [object Object]', () => {
  const art = buildActionArtifact({ number: 1, action: 'close', contentHash: 'h', evidence: { commit: 'abc', lines: ['x'] } });
  assert.match(art, /abc/);
  assert.ok(!art.includes('[object Object]'));
});

test('the artifact asks about THIS action rather than the batch', () => {
  // The attribution property: a reviewer reading it can only be answering about
  // one issue at one revision, so its verdict cannot be stretched over others.
  const art = buildActionArtifact(action());
  assert.match(art, /for this issue, at this revision/);
});

// ---- a thrown review is a spent attempt ------------------------------------

test('AC14: a THROWN review is recorded, so it cannot be retried until it passes', () => {
  // Without this the one-shot rule is unenforced for exactly the case a caller
  // can manufacture at will: kill the reviewer, retry, repeat until an approve.
  const ledger = {};
  const first = gateAction({ action: action(), profile: profile(), ledger, runReview: () => { throw new Error('timeout'); } });
  assert.equal(first.verdict, 'demote');
  assert.ok(ledger[gateKey(action())], 'the spent attempt must be on the ledger');

  let called = 0;
  const second = gateAction({ action: action(), profile: profile(), ledger, runReview: () => { called += 1; return { code: REVIEW_APPROVE }; } });
  assert.equal(called, 0, 'a failed review has spent the one shot for this revision');
  assert.equal(second.verdict, 'demote');
});

// ---- ledgerApproves: the authorization predicate ---------------------------

test('ledgerApproves requires an approve bound to the same issue AND revision', () => {
  const a = action();
  assert.equal(ledgerApproves({ [gateKey(a)]: { verdict: 'approve', contentHash: a.contentHash, number: a.number, action: a.action } }, a), true);
  assert.equal(ledgerApproves({ [gateKey(a)]: { verdict: 'demote', contentHash: a.contentHash, number: a.number, action: a.action } }, a), false);
  assert.equal(ledgerApproves({ [gateKey(a)]: { verdict: 'approve', contentHash: 'other', number: a.number, action: a.action } }, a), false);
  assert.equal(ledgerApproves({ [gateKey(a)]: { verdict: 'approve', contentHash: a.contentHash, number: 999, action: a.action } }, a), false);
  assert.equal(ledgerApproves({}, a), false);
  assert.equal(ledgerApproves(null, a), false);
});

test('a close and a relabel on the same issue and revision are separate decisions', () => {
  // The keys must not collide: whichever was gated first would otherwise refuse
  // the second as a replay of a decision that was never about it.
  const a = { number: 7, action: 'close', contentHash: 'h' };
  const b = { number: 7, action: 'relabel', contentHash: 'h' };
  assert.notEqual(gateKey(a), gateKey(b));

  const ledger = {};
  const first = gateAction({ action: a, profile: profile(), ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }) });
  assert.equal(first.verdict, 'demote');
  const second = gateAction({ action: b, profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  assert.equal(second.verdict, 'approve', 'a different action is a different decision');
});

test('an approval for a close does not license a relabel', () => {
  const a = { number: 7, action: 'close', contentHash: 'h' };
  const approvedClose = { [gateKey(a)]: { verdict: 'approve', contentHash: 'h', number: 7, action: 'close' } };
  assert.equal(ledgerApproves(approvedClose, { number: 7, action: 'relabel', contentHash: 'h' }), false);
});

test('a priority relabel and an area relabel on one issue are separate decisions', () => {
  // Same action, same revision, different field. Without the field in the key
  // the first to be gated records it and the second is refused as a replay of a
  // decision that was about something else entirely.
  const a = { number: 7, action: 'relabel', field: 'priority', contentHash: 'h' };
  const b = { number: 7, action: 'relabel', field: 'area', contentHash: 'h' };
  assert.notEqual(gateKey(a), gateKey(b));

  const ledger = {};
  gateAction({ action: a, profile: profile(), ledger, runReview: () => ({ code: REVIEW_NEEDS_ATTENTION }) });
  const second = gateAction({ action: b, profile: profile(), ledger, runReview: () => ({ code: REVIEW_APPROVE }) });
  assert.equal(second.verdict, 'approve');
});

test('an approval for one relabel field does not license another', () => {
  const a = { number: 7, action: 'relabel', field: 'priority', contentHash: 'h' };
  const approvedPriority = { [gateKey(a)]: { verdict: 'approve', contentHash: 'h', number: 7, action: 'relabel', field: 'priority' } };
  assert.equal(ledgerApproves(approvedPriority, { number: 7, action: 'relabel', field: 'area', contentHash: 'h' }), false);
});
