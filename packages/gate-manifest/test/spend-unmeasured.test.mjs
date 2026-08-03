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
  // NON-VACUITY FIRST. Without this, `for (const d of found)` over an empty
  // array runs zero assertions and reports success — which is exactly what this
  // test did before review caught it, masking a diagnostics() that had never
  // been updated at all.
  assert.ok(found.length > 0, 'diagnostics must actually say something about an unmeasured ledger');
  assert.ok(found.some((d) => /COUNTS, NOT SPEND/.test(d)), `the call-shape line is present: ${found}`);
  for (const d of found) {
    assert.match(d, /call/i, `a count-derived diagnostic must name itself: ${d}`);
    assert.ok(!/% of recorded spend/.test(d), `it must not claim to have measured spend: ${d}`);
  }
});

test('diagnostics never invent a token share for an unmeasured phase', () => {
  const found = diagnostics(aggregateSpend([unmeasured('flail-detector'), unmeasured('premortem')]));
  assert.ok(found.length > 0, 'non-vacuity: there is something to check');
  for (const d of found) {
    assert.ok(!/\d+% of recorded spend/.test(d), `no spend percentage may be derived from counts: ${d}`);
  }
});

test('a phase whose P7 calls were merely UNMEASURED is not reported as missing P7', () => {
  // "No P7 spend recorded — the compounding loop is broken" is a claim about
  // work not happening. A P7 bucket holding unmeasured calls means the work DID
  // happen and was not priced; saying it is broken would be the same
  // unknown-read-as-zero this change exists to remove.
  const found = diagnostics(aggregateSpend([
    measured('prosecute', U(10_000, 1000)),
    measured('spec-lint', U(1000, 100)),
    unmeasured('lesson-foundry'),
  ]));
  assert.ok(!found.some((d) => /No P7/.test(d)), `P7 work happened, just unpriced: ${found}`);
});

test('a ledger with NO unmeasured calls produces no count-shape noise', () => {
  // The new lines must not appear on a fully measured ledger — otherwise every
  // existing operator gains a caveat that does not apply to them.
  const found = diagnostics(aggregateSpend([
    measured('flail-detector', U(10_000, 1000)),
    measured('spec-lint', U(1000, 100)),
  ]));
  assert.ok(!found.some((d) => /COUNTS, NOT SPEND/.test(d)));
  assert.ok(!found.some((d) => /MEASURED tokens only/.test(d)));
  assert.ok(found.some((d) => /P4/.test(d)), 'the existing token diagnostics still fire');
});

// ---------------------------------------------------------------------------
// Regressions found by adversarial review
// ---------------------------------------------------------------------------

test('the call-shape count describes exactly the phases it lists, never unphased ones', () => {
  // `unmeasuredCalls` is a whole-ledger total. Quoting it beside a shape that
  // excludes `unphased` attributed unphased calls to the phases shown — and
  // could state a number LARGER than the calls listed.
  const found = diagnostics(aggregateSpend([
    measured('premortem', U(100, 50)),
    measured('coldstart', U(100, 50)),
    { gate: 'some-unmapped-tool', data: { usageStatus: 'unreported' } },
    { gate: 'some-unmapped-tool', data: { usageStatus: 'unreported' } },
  ]));
  const shapeLine = found.find((d) => /COUNTS, NOT SPEND/.test(d));
  // Both phased calls were MEASURED, so there is no honest count-shape claim to
  // make about them at all.
  assert.equal(shapeLine, undefined, `no phased call was unmeasured: ${found}`);
});

test('a measured CACHE-HIT call is never erased by the "tokens unknown" total', () => {
  // totalTokens() sums input+output only. A real measured call with 0 in, 0 out
  // and 500 cached would have made the total line claim "none of these calls
  // reported usage", discarding a measured call and its cached tokens.
  const lines = renderSpendReport(aggregateSpend([
    measured('premortem', U(0, 0, 500)),
    unmeasured('flail-detector'),
  ])).join('\n');
  assert.ok(
    !/none of these calls reported usage/.test(lines),
    `a measured call exists, so this claim is false:\n${lines}`,
  );
  assert.match(lines, /cached=500/, 'the cached tokens survive into the total');
});

// ---------------------------------------------------------------------------
// Hostile / malformed ledger entries
//
// A manifest is append-only evidence read long after it was written, by a
// version of this code that did not exist then. Every branch below is a DECISION
// rather than an accident, pinned so it stays one.
// ---------------------------------------------------------------------------

const HOSTILE = [
  null,
  undefined,
  {},
  { gate: 'premortem' },
  { gate: 'premortem', data: null },
  { gate: 'premortem', data: { usageStatus: '' } },
  { gate: 'premortem', data: { usageStatus: 42 } },
  { gate: 'premortem', data: { usage: 'not-an-object', usageStatus: 'reported' } },
  { gate: 'premortem', data: { usage: null, usageStatus: 'unreported' } },
  { data: { usageStatus: 'unreported' } },
  { gate: 'a-gate-this-version-never-heard-of', data: { usageStatus: 'unreported' } },
];

test('malformed entries never throw, in aggregation OR rendering', () => {
  const agg = aggregateSpend(HOSTILE);
  assert.doesNotThrow(() => renderSpendReport(agg));
  assert.doesNotThrow(() => diagnostics(agg));
});

test('an unusable usage VALUE is treated as unmeasured, never trusted', () => {
  // `usage: 'not-an-object'` and `usage: null` both mean the counters cannot be
  // read. Counting them as measured would put garbage into token totals; the
  // call still happened, so it lands in the unmeasured column instead.
  const agg = aggregateSpend([
    { gate: 'premortem', data: { usage: 'not-an-object', usageStatus: 'reported' } },
    { gate: 'premortem', data: { usage: null, usageStatus: 'unreported' } },
  ]);
  assert.equal(agg.entriesWithUsage, 0, 'nothing unusable is counted as measured');
  assert.equal(agg.byPhase.P1.unmeasuredCalls, 2);
  assert.equal(agg.byPhase.P1.inputTokens, 0, 'no garbage reaches the token totals');
});

test('a status that is not a non-empty string is not evidence of a call', () => {
  const agg = aggregateSpend([
    { gate: 'premortem', data: { usageStatus: '' } },
    { gate: 'premortem', data: { usageStatus: 42 } },
  ]);
  assert.deepEqual(agg.byPhase, {}, 'an unreadable status claims nothing');
  assert.equal(agg.unmeasuredCalls, 0);
});

test('an unknown or missing gate lands in unphased, never dropped and never mis-attributed', () => {
  // A ledger outlives the PHASE_BY_GATE table that reads it. A gate this
  // version does not know is still a call that happened; `unphased` is where it
  // is visible without being credited to a phase it may not belong to.
  const agg = aggregateSpend([
    { data: { usageStatus: 'unreported' } },
    { gate: 'a-gate-this-version-never-heard-of', data: { usageStatus: 'unreported' } },
  ]);
  assert.equal(agg.byPhase.unphased.unmeasuredCalls, 2);
  assert.equal(agg.unmeasuredCalls, 2);
});

test('aggregation is order-independent', () => {
  const a = aggregateSpend(HOSTILE);
  const b = aggregateSpend([...HOSTILE].reverse());
  assert.deepEqual(a.byPhase, b.byPhase);
  assert.equal(a.unmeasuredCalls, b.unmeasuredCalls);
  assert.deepEqual(a.total, b.total);
});

// ---------------------------------------------------------------------------
// Round-5 regressions
// ---------------------------------------------------------------------------

test('a mostly-measured ledger keeps its spend shares and does NOT get a counts-not-spend header', () => {
  // One unmeasured call among many measured ones used to announce that the whole
  // distribution was "COUNTS, NOT SPEND" while accurate token shares sat right
  // beneath it — self-contradicting, and it discredits real figures. The
  // measured-only caveat says the same thing without doing that.
  const found = diagnostics(aggregateSpend([
    measured('flail-detector', U(10_000, 1000)),
    measured('spec-lint', U(1000, 100)),
    measured('prosecute', U(5000, 500)),
    unmeasured('lesson-foundry'),
  ]));
  assert.ok(!found.some((d) => /COUNTS, NOT SPEND/.test(d)), `shares are computable here: ${found}`);
  assert.ok(found.some((d) => /MEASURED tokens only/.test(d)), 'but the limitation is still stated');
  assert.ok(found.some((d) => /P4/.test(d)), 'and the real token diagnostics still fire');
});

test('the counts-not-spend view appears only when no share of spend can be computed', () => {
  const found = diagnostics(aggregateSpend([unmeasured('premortem'), unmeasured('flail-detector')]));
  assert.ok(found.some((d) => /COUNTS, NOT SPEND/.test(d)), `nothing is measured here: ${found}`);
});

test('a status outside the closed vocabulary is NOT evidence of a call', () => {
  // The ledger is append-only and outlives this code. A future status meaning
  // the opposite — a gate that was skipped, disabled, or failed before calling
  // anything — must not be counted as a call and inflate its phase.
  const agg = aggregateSpend([
    { gate: 'premortem', data: { usageStatus: 'skipped' } },
    { gate: 'premortem', data: { usageStatus: 'failed' } },
    { gate: 'premortem', data: { usageStatus: 'disabled' } },
  ]);
  assert.deepEqual(agg.byPhase, {}, 'none of these asserts a model call happened');
  assert.equal(agg.unmeasuredCalls, 0);
});

test('every status the closed vocabulary DOES define still counts', () => {
  // The guard must not be so strict that it drops real calls: `reported` with an
  // unusable usage value, and `unreported`, are both real calls.
  const agg = aggregateSpend([
    { gate: 'premortem', data: { usageStatus: 'unreported' } },
    { gate: 'premortem', data: { usage: 'unusable', usageStatus: 'reported' } },
    { gate: 'premortem', data: { usage: null, usageStatus: 'claimed' } },
  ]);
  assert.equal(agg.byPhase.P1.unmeasuredCalls, 3);
});

test('the TOTAL line states the true total, and never a count that contradicts it', () => {
  // `total: 3 call(s) ... 2 further call(s) unmeasured` said 3 where 5 calls
  // happened. Anything scraping the familiar `total: N call(s)` shape — a human
  // included — would record the wrong number.
  const lines = renderSpendReport(aggregateSpend([
    measured('premortem', U(1000, 500)),
    measured('premortem', U(0, 0, 10)),
    measured('hollow-test', U(10, 5)),
    unmeasured('flail-detector'),
    unmeasured('lesson-foundry'),
  ])).join('\n');

  const totalLine = lines.split('\n').find((l) => l.startsWith('total:'));
  assert.ok(totalLine, `there is a total line:\n${lines}`);
  assert.match(totalLine, /^total: 5 call\(s\)/, `5 calls happened: ${totalLine}`);
  assert.match(totalLine, /3 measured/, 'and the breakdown is explicit');
  assert.match(totalLine, /2 unmeasured/);
});

test('a fully measured ledger keeps the original, unqualified total line', () => {
  const lines = renderSpendReport(aggregateSpend([measured('premortem', U(100, 50))])).join('\n');
  const totalLine = lines.split('\n').find((l) => l.startsWith('total:'));
  assert.match(totalLine, /^total: 1 call\(s\), 150 tokens/, `no new caveats for a measured ledger: ${totalLine}`);
  assert.ok(!/unmeasured/.test(totalLine));
});
