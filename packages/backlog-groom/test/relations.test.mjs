// relations.test.mjs — AC11, AC19.
//
// Relations are JUDGMENTS, not similarity scores (spec §3.4). Similarity is a
// candidate FILTER and never evidence, and the filter's recall is the ceiling on
// what can ever be found — a pair it never surfaces is a relation the tool
// cannot report. So the filter's threshold and what it excluded are reported
// with the run rather than hidden.
//
// The three outcomes must stay distinguishable. The worked example from the
// intent: #324 (dev-machine flakiness) vs #990 (a CI clone race) are NOT
// duplicates despite heavy vocabulary overlap, because #324's own text scopes
// itself to developer machines; and #992 is not a duplicate of #990 but CAUSED
// by it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { candidatePairs, emitRelations, similarity, tokens, MAX_TOKENS_PER_ISSUE, RELATION_KINDS } from '../lib/relations.mjs';

const ISSUES = [
  { number: 324, title: 'Full suite is flaky on developer machines', body: 'varying 2-4 segments fail, never in CI', labels: ['bug'] },
  { number: 990, title: 'flaky (CI): autopilot clone fails copying a loose object', body: 'nested gate-deps repo clone race in CI', labels: ['bug'] },
  { number: 992, title: 'autopilot: continueRun init-failure handler lacks the guard', body: 'unhandled rejection when a record vanishes', labels: ['bug'] },
  { number: 700, title: 'docs: rewrite the onboarding page', body: 'the getting started guide is stale', labels: ['documentation'] },
];

test('AC19: the candidate filter reports its threshold and what it excluded', () => {
  const { pairs, stats } = candidatePairs(ISSUES, { threshold: 0.2 });
  assert.equal(stats.threshold, 0.2);
  assert.equal(stats.pairsTotal, 6, 'n(n-1)/2 for 4 issues');
  assert.equal(stats.pairsSurfaced, pairs.length);
  assert.equal(stats.pairsExcluded, stats.pairsTotal - stats.pairsSurfaced);
  assert.ok(stats.excludedRate >= 0 && stats.excludedRate <= 1);
});

test('AC19: the excluded count is the honest ceiling statement — it bounds what could have been found', () => {
  // A true "miss rate" needs ground truth this tool does not have. What IS
  // knowable, and what the report states, is how many pairs judgment never got
  // to see. A threshold high enough to exclude everything must say so loudly
  // rather than reporting "no relations found".
  const { pairs, stats } = candidatePairs(ISSUES, { threshold: 0.99 });
  assert.equal(pairs.length, 0);
  assert.equal(stats.pairsExcluded, stats.pairsTotal);
  assert.equal(stats.excludedRate, 1, 'a run that surfaced nothing must not read as a run that found nothing');
});

test('AC19: lowering the threshold surfaces more pairs — the knob is real', () => {
  const strict = candidatePairs(ISSUES, { threshold: 0.6 }).pairs.length;
  const loose = candidatePairs(ISSUES, { threshold: 0.05 }).pairs.length;
  assert.ok(loose >= strict);
});

test('AC19: no relation is emitted for a pair the filter never surfaced', () => {
  const judge = () => ({ kind: 'duplicate-of', evidence: 'same root cause' });
  const { pairs } = candidatePairs(ISSUES, { threshold: 0.99 });
  const { relations } = emitRelations(pairs, judge);
  assert.deepEqual(relations, [], 'judgment cannot confirm what it was never shown');
});

test('AC11: a relation is emitted only when judgment confirms it', () => {
  const { pairs } = candidatePairs(ISSUES, { threshold: 0.05 });
  const { relations } = emitRelations(pairs, () => null);
  assert.deepEqual(relations, [], 'a declined judgment emits nothing');
});

test('AC11: a judgment with no evidence beyond similarity is refused', () => {
  const { pairs } = candidatePairs(ISSUES, { threshold: 0.05 });
  const bare = emitRelations(pairs, () => ({ kind: 'duplicate-of' }));
  assert.deepEqual(bare.relations, [], 'no evidence, no relation');
  assert.ok(bare.refused.length > 0, 'and the refusal is reported, not silent');

  const scoreOnly = emitRelations(pairs, (_a, _b, score) => ({ kind: 'duplicate-of', evidence: `similarity ${score}` }));
  assert.deepEqual(scoreOnly.relations, [], 'evidence that merely restates the score is not evidence');
});

test('AC11: the three relation kinds are exactly these three', () => {
  // Pinned as a literal, not iterated. A test that loops RELATION_KINDS shrinks
  // with it: dropping `superseded-by` from the constant would delete the case
  // that proves superseded-by is distinguishable, and the suite would stay
  // green while the capability vanished.
  assert.deepEqual([...RELATION_KINDS], ['duplicate-of', 'related-to', 'superseded-by']);
});

test('AC11: duplicate-of, related-to and superseded-by are distinguishable outcomes', () => {
  const { pairs } = candidatePairs(ISSUES, { threshold: 0.05 });
  for (const kind of RELATION_KINDS) {
    const { relations } = emitRelations(pairs.slice(0, 1), () => ({ kind, evidence: 'the same nested clone race reaches both handlers' }));
    assert.equal(relations[0].kind, kind);
  }
});

test('AC11: an unknown relation kind is refused rather than passed through', () => {
  const { pairs } = candidatePairs(ISSUES, { threshold: 0.05 });
  const { relations, refused } = emitRelations(pairs.slice(0, 1), () => ({ kind: 'sort-of-like', evidence: 'a real reason here' }));
  assert.deepEqual(relations, []);
  assert.match(refused[0].why, /kind/i);
});

test('AC11: the worked example — vocabulary overlap alone does not make a duplicate', () => {
  // #324 and #990 share "flaky", "fail", "suite" vocabulary. The filter may well
  // surface them; judgment must be what decides, and when it declines, no
  // relation is emitted however similar they looked.
  const pair = candidatePairs([ISSUES[0], ISSUES[1]], { threshold: 0.01 }).pairs;
  assert.equal(pair.length, 1, 'the filter surfaces them');
  const { relations } = emitRelations(pair, () => null);
  assert.deepEqual(relations, [], 'and judgment refuses them');
});

test('AC11: a relation records both issue numbers and the evidence, never the score alone', () => {
  const pair = candidatePairs([ISSUES[1], ISSUES[2]], { threshold: 0.01 }).pairs;
  const { relations } = emitRelations(pair, () => ({ kind: 'related-to', evidence: 'the clone failure in one reaches the unguarded handler in the other' }));
  assert.deepEqual([relations[0].from, relations[0].to].sort(), [990, 992]);
  assert.match(relations[0].evidence, /unguarded handler/);
});

test('AC19: a pair is never compared with itself, and each pair appears once', () => {
  const { pairs } = candidatePairs(ISSUES, { threshold: 0.01 });
  const seen = new Set();
  for (const p of pairs) {
    assert.notEqual(p.a.number, p.b.number);
    const key = [p.a.number, p.b.number].sort().join('-');
    assert.ok(!seen.has(key), 'no pair twice');
    seen.add(key);
  }
});

test('AC19: an empty or single-issue backlog produces no pairs and a coherent stats block', () => {
  for (const set of [[], [ISSUES[0]]]) {
    const { pairs, stats } = candidatePairs(set, { threshold: 0.2 });
    assert.deepEqual(pairs, []);
    assert.equal(stats.pairsTotal, 0);
    assert.equal(stats.excludedRate, 0, 'nothing to exclude is not the same as excluding everything');
  }
});

test('AC19: stopwords carry no similarity — a shared "was" is not overlap', () => {
  // The stopword list is load-bearing, not decorative: without it, two issues
  // sharing only filler words surface as candidates and burn judgment calls.
  const a = { number: 1, title: 'it was', body: 'this was that' };
  const b = { number: 2, title: 'was it', body: 'that was this' };
  assert.equal(similarity(a, b), 0, 'every shared token here is a stopword');
});

test('AC19: a real shared term does produce similarity, so the filter is not inert', () => {
  const a = { number: 1, title: 'clone race in gate-deps', body: 'nested repository' };
  const b = { number: 2, title: 'clone race elsewhere', body: 'nested repository' };
  assert.ok(similarity(a, b) > 0);
});

test('AC19: tokens per issue are bounded, so a pasted log cannot dominate the sweep', () => {
  // Bodies are deliberately uncapped at fetch, because a truncated body drops
  // citations. Relation filtering is O(n²) though, so a few issues carrying
  // pasted logs would otherwise decide how long the whole run takes. Similarity
  // is a coarse filter; the full body still reaches verification and judgment.
  const huge = { number: 1, title: 't', body: Array.from({ length: 5000 }, (_, i) => `token${i}`).join(' ') };
  assert.equal(tokens(huge).size, MAX_TOKENS_PER_ISSUE);
});

test('AC19: the token bound is 400 — low enough to cap a pasted log, high enough to leave real issues whole', () => {
  // Pinned deliberately. The value is a trade-off an operator can reason about:
  // raising it lets one enormous issue dominate an O(n^2) sweep, lowering it
  // starts truncating the vocabulary of ordinary issues and blunts the filter.
  assert.equal(MAX_TOKENS_PER_ISSUE, 400);
});

test('AC19: the bound is high enough that ordinary issues are unaffected', () => {
  const ordinary = { number: 2, title: 'a normal issue title', body: 'a few sentences of ordinary prose about a defect in a file somewhere' };
  assert.ok(tokens(ordinary).size < MAX_TOKENS_PER_ISSUE);
});

test('AC19: tokens are MEMOISED per issue — the same set instance comes back', () => {
  // Asserted by identity because the alternative is invisible: without the
  // cache every result is still correct, and only the O(n^2) sweep gets slower.
  const issue = { number: 1, title: 'a title', body: 'some prose about a defect' };
  assert.equal(tokens(issue), tokens(issue), 'a repeated call must reuse the computed set');

  const twin = { number: 1, title: 'a title', body: 'some prose about a defect' };
  assert.notEqual(tokens(issue), twin === issue ? tokens(issue) : tokens(twin), 'a different object gets its own set');
  assert.deepEqual([...tokens(issue)].sort(), [...tokens(twin)].sort(), 'with equal contents');
});
