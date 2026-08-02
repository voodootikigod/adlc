// An UNMEASURED call is counted, never discarded and never priced.
//
// `aggregateSpend` used to `continue` on any entry without `data.usage`, so a
// call that demonstrably happened but was never token-measured contributed
// NOTHING — not even a call count. That is T152's "unknown collapsing into
// zero", reintroduced one layer up: there, a zeroed usage object would have
// booked an unmeasured call as a measured free one; here, the absence of one
// booked it as never having happened.
//
// The distinction matters most for the workflow the toolkit documents: every
// LLM-backed gate supports --prompt-only, whose model call is made by the
// operator's harness and whose tokens the tool cannot see.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateSpend, diagnostics, renderSpendReport } from '../lib/spend.mjs';

const measured = (gate, usage) => ({ gate, data: { usage, usageStatus: 'reported' } });
const unmeasured = (gate) => ({ gate, data: { usageStatus: 'unreported' } });
const U = (i, o, c = 0) => ({ inputTokens: i, outputTokens: o, cachedTokens: c });

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

test('an unmeasured entry contributes a call and ZERO tokens', () => {
  const agg = aggregateSpend([unmeasured('premortem')]);
  const p1 = agg.byPhase.P1;
  assert.ok(p1, 'the phase appears at all — today it does not');
  // `calls` keeps its established meaning: MEASURED calls. It is the denominator
  // every per-call token average divides by, so an unmeasured call must not
  // dilute it — it lands in its own counter instead.
  assert.equal(p1.calls, 0);
  assert.equal(p1.inputTokens, 0);
  assert.equal(p1.outputTokens, 0);
  assert.equal(p1.cachedTokens, 0);
  assert.equal(p1.unmeasuredCalls, 1, 'the bucket says how many of its calls were unmeasured');
});

test('a ledger with ONLY unmeasured calls still has a per-phase shape', () => {
  // This is the operator's real situation: a --prompt-only workflow records
  // verdicts for months and `adlc spend` reports "no recorded usage".
  const agg = aggregateSpend([
    unmeasured('premortem'), unmeasured('premortem'),
    unmeasured('coldstart'),
    unmeasured('hollow-test'),
  ]);
  assert.deepEqual(Object.keys(agg.byPhase).sort(), ['P1', 'P2', 'P5']);
  assert.equal(agg.byPhase.P1.unmeasuredCalls, 2);
  assert.equal(agg.byPhase.P2.unmeasuredCalls, 1);
  assert.equal(agg.byPhase.P5.unmeasuredCalls, 1);
  assert.equal(agg.total.calls, 0, 'nothing was measured');
  assert.equal(agg.total.inputTokens + agg.total.outputTokens, 0, 'no tokens are invented');
  assert.equal(agg.unmeasuredCalls, 4);
});

test('a phase mixing measured and unmeasured calls reports BOTH, distinguishably', () => {
  // Without this a reader cannot tell "40k tokens over 2 calls" from "40k
  // tokens over 2 measured calls plus 3 we could not see" — and would compute a
  // per-call average over a denominator that is partly unknown.
  const agg = aggregateSpend([
    measured('premortem', U(100, 50)),
    unmeasured('premortem'),
    unmeasured('premortem'),
  ]);
  const p1 = agg.byPhase.P1;
  assert.equal(p1.calls, 1, 'one measured call');
  assert.equal(p1.unmeasuredCalls, 2, 'and two more that carried no tokens');
  assert.equal(p1.inputTokens, 100, 'the measured tokens are untouched');
  assert.equal(p1.outputTokens, 50);
});

test('an idempotent REPLAY is not a second call', () => {
  // prosecute records a replayed pass as {usageStatus:'claimed', usageReplayOf}
  // with NO usage — deliberately, so counters are not recorded twice. That is
  // exactly the shape "has a status, has no usage", so a naive rule would count
  // one model call three times here.
  const replay = (gate) => ({ gate, data: { usageStatus: 'claimed', usageReplayOf: 'call-key-1' } });
  const agg = aggregateSpend([unmeasured('prosecute'), replay('prosecute'), replay('prosecute')]);
  assert.equal(agg.byPhase.P5.unmeasuredCalls, 1, 'one real call, two replays of it');
  assert.equal(agg.unmeasuredCalls, 1);
});

test('an entry with no usage AND no status is not a call at all', () => {
  // Most ledger entries are ceremony — ticket-complete, rails-frozen — and were
  // never a model call. They must not become one.
  const agg = aggregateSpend([{ gate: 'premortem', data: { promptOnly: true } }, { gate: 'coldstart' }]);
  assert.deepEqual(agg.byPhase, {}, 'a verdict with no status is not evidence of a call');
  assert.equal(agg.unmeasuredCalls, 0);
});

// ---------------------------------------------------------------------------
// The measured path is untouched
// ---------------------------------------------------------------------------

test('a measured-only ledger aggregates exactly as before', () => {
  const entries = [measured('premortem', U(100, 50, 10)), measured('hollow-test', U(7, 3))];
  const agg = aggregateSpend(entries);
  assert.equal(agg.byPhase.P1.inputTokens, 100);
  assert.equal(agg.byPhase.P1.outputTokens, 50);
  assert.equal(agg.byPhase.P1.cachedTokens, 10);
  assert.equal(agg.byPhase.P1.calls, 1);
  assert.equal(agg.byPhase.P1.unmeasuredCalls, 0, 'a fully measured bucket says so');
  assert.equal(agg.total.inputTokens, 107);
  assert.equal(agg.entriesWithUsage, 2, 'entriesWithUsage keeps its original meaning');
  assert.equal(agg.unmeasuredCalls, 0);
});

// ---------------------------------------------------------------------------
// Reporting — the place this change could do harm
// ---------------------------------------------------------------------------

test('the report shows the shape instead of the "no recorded usage" dead end', () => {
  const lines = renderSpendReport(aggregateSpend([
    unmeasured('premortem'), unmeasured('premortem'), unmeasured('flail-detector'),
  ])).join('\n');
  assert.ok(!lines.includes('no recorded usage'), `the dead end must be gone:\n${lines}`);
  assert.match(lines, /P1/);
  assert.match(lines, /2/, 'the call count is shown');
  assert.match(lines, /unknown|unmeasured/i, 'and it says the tokens are not known');
});

test('an unmeasured phase is never rendered as a PERCENTAGE of anything', () => {
  // The barbell is a claim about SPEND. One P1 call against a frontier model and
  // one P4 call on a cheap seat are both "one call" and can differ by orders of
  // magnitude, so a call-count share presented like a token share would be a
  // confident wrong number — worse than the silence it replaced.
  const lines = renderSpendReport(aggregateSpend([
    unmeasured('premortem'), unmeasured('flail-detector'), unmeasured('flail-detector'),
  ])).join('\n');
  assert.ok(!/%/.test(lines), `no share arithmetic over an unmeasured denominator:\n${lines}`);
});

test('a 0-token unmeasured phase never reads as "this phase was free"', () => {
  const lines = renderSpendReport(aggregateSpend([unmeasured('premortem')])).join('\n');
  assert.ok(!/\b0 tokens\b/.test(lines), `an unknown cost must not print as zero:\n${lines}`);
});

test('a mixed ledger still prices the MEASURED phases', () => {
  const lines = renderSpendReport(aggregateSpend([
    measured('premortem', U(1000, 500)),
    unmeasured('flail-detector'),
  ])).join('\n');
  assert.match(lines, /1500|1000/, 'real token totals are still reported');
  assert.match(lines, /unknown|unmeasured/i, 'and the unmeasured phase is flagged');
});

// ---------------------------------------------------------------------------
// Diagnostics may reason about shape, never price it
// ---------------------------------------------------------------------------

test('a diagnostic over unmeasured calls says it is counting CALLS, not spend', () => {
  // Otherwise a §6 finding phrased as "% of recorded spend" appears over
  // evidence that contains no spend at all.
  const found = diagnostics(aggregateSpend([
    unmeasured('flail-detector'), unmeasured('flail-detector'), unmeasured('flail-detector'),
    unmeasured('premortem'),
  ]));
  for (const d of found) {
    assert.match(d, /call/i, `a count-derived diagnostic must name itself: ${d}`);
    assert.ok(!/% of recorded spend/.test(d), `it must not claim to have measured spend: ${d}`);
  }
});

test('diagnostics never invent a token share for an unmeasured phase', () => {
  const found = diagnostics(aggregateSpend([unmeasured('flail-detector'), unmeasured('premortem')]));
  for (const d of found) {
    assert.ok(!/\d+% of recorded spend/.test(d), `no spend percentage may be derived from counts: ${d}`);
  }
});
