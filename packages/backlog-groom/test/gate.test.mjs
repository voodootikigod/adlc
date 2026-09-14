// gate.test.mjs — the adversarial gate (spec §3.6): AC7, AC8, AC14, AC25.
//
// The gate's job is to be unbypassable, so most of what follows is about the
// ways a determined caller gets a second opinion it likes better: replaying a
// reworded artifact, reviewing with itself, or reading an error as an approve.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_CONFIDENCE,
  REVIEW_APPROVE,
  REVIEW_NEEDS_ATTENTION,
  reviewerPair,
  gateKey,
  gateAction,
  reviewArgv,
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
