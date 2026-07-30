import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceTicketOutcomes, statusForTicket } from '../lib/outcomes.mjs';

test('no P5 entry → null status (never fabricate a pass)', () => {
  const entries = [{ ticket: 'T1', gate: 'p0', seq: 1 }, { ticket: 'T1', gate: 'rails-bypass', seq: 2 }];
  assert.equal(statusForTicket(entries, 'T1'), null);
});

test('latest P5 verdict wins (a later pass supersedes an earlier fail)', () => {
  const entries = [
    { ticket: 'T1', gate: 'prosecution', seq: 1, data: { verdict: 'blocked' } },
    { ticket: 'T1', gate: 'prosecution', seq: 5, data: { verdict: 'clear' } },
  ];
  assert.equal(statusForTicket(entries, 'T1'), 'p5-pass');
});

test('latest P5 verdict wins (a later fail supersedes an earlier pass)', () => {
  const entries = [
    { ticket: 'T1', gate: 'prosecution', seq: 5, data: { verdict: 'clear' } },
    { ticket: 'T1', gate: 'prosecution', seq: 9, data: { verdict: 'blocked' } },
  ];
  assert.equal(statusForTicket(entries, 'T1'), 'p5-fail');
});

test('reduces latest-per-gate and is per-ticket', () => {
  const entries = [
    { ticket: 'T1', gate: 'p0', seq: 1 },
    { ticket: 'T1', gate: 'p0', seq: 3 },
    { ticket: 'T2', gate: 'prosecution', seq: 4, data: { verdict: 'clear' } },
  ];
  const r = reduceTicketOutcomes(entries);
  assert.equal(r.get('T1').gates.p0.seq, 3, 'latest p0 entry kept');
  assert.equal(r.get('T2').status, 'p5-pass');
  assert.equal(r.get('T1').status, null);
});

test('entries without a ticket binding are ignored', () => {
  const entries = [{ gate: 'prosecution', seq: 1, data: { verdict: 'clear' } }, { ticket: 'T1', gate: 'p0', seq: 2 }];
  const r = reduceTicketOutcomes(entries);
  assert.equal(r.size, 1);
  assert.ok(r.has('T1'));
});

test('falls back to ts when seq is absent', () => {
  const entries = [
    { ticket: 'T1', gate: 'prosecution', ts: '2026-01-01T00:00:00Z', data: { verdict: 'blocked' } },
    { ticket: 'T1', gate: 'prosecution', ts: '2026-02-01T00:00:00Z', data: { verdict: 'clear' } },
  ];
  assert.equal(statusForTicket(entries, 'T1'), 'p5-pass');
});

test('ts tiebreak is driven by the timestamp, NOT array order (later ts wins even when listed first)', () => {
  // Pin the ts fallback itself: with the later entry FIRST in the array, only a real
  // Date.parse(ts) comparison yields the right answer — a degenerate seqOf (always 0)
  // would let the array-last (older) entry win.
  const entries = [
    { ticket: 'T1', gate: 'prosecution', ts: '2026-02-01T00:00:00Z', data: { verdict: 'clear' } },
    { ticket: 'T1', gate: 'prosecution', ts: '2026-01-01T00:00:00Z', data: { verdict: 'blocked' } },
  ];
  assert.equal(statusForTicket(entries, 'T1'), 'p5-pass', 'the Feb "clear" verdict must win regardless of order');
});

// T-MANIFEST-FOREST (adversarial-review finding): once the manifest is segmented,
// a ticket's evidence can span root (frozen at cutover) and this checkout's own
// open segment. Each chain restarts `seq` at 1, so a stale root pass at a HIGH seq
// must never outrank a causally-later segment fail at a LOW one — push.mjs kept
// publishing a stale "passing" status after a segment recorded a real failure.
test('a causally-later SEGMENT verdict wins over a stale ROOT one, regardless of seq magnitude', () => {
  const rootChain = [
    { ticket: 'T1', gate: 'prosecution', seq: 100, data: { verdict: 'clear' } },
  ];
  const segmentChain = [
    { ticket: 'T1', gate: 'prosecution', seq: 1, data: { verdict: 'blocked' } },
  ];
  const r = reduceTicketOutcomes([rootChain, segmentChain]);
  assert.equal(r.get('T1').status, 'p5-fail', 'the segment fail (causally later) must win over the stale root pass');
  assert.equal(r.get('T1').gates.prosecution.data.verdict, 'blocked');
});

test('a single-chain input (flat array) still uses value-based seq/ts comparison, not chain position', () => {
  // Regression guard: passing a flat array (the non-segmented / legacy call shape)
  // must behave EXACTLY as before — no implicit chain-splitting.
  const entries = [
    { ticket: 'T1', gate: 'prosecution', seq: 100, data: { verdict: 'clear' } },
    { ticket: 'T1', gate: 'prosecution', seq: 1, data: { verdict: 'blocked' } },
  ];
  const r = reduceTicketOutcomes(entries);
  assert.equal(r.get('T1').status, 'p5-pass', 'within one chain, the higher seq (100) still wins');
});

test('across DIFFERENT P5-family gate names, the causally-later chain wins regardless of gate iteration order', () => {
  // 'prosecution' is iterated AFTER 'p5' in P5_GATES — pin that deriveStatus
  // picks by chain priority, not by "whichever gate name comes last".
  const rootChain = [{ ticket: 'T1', gate: 'prosecution', seq: 1, data: { verdict: 'blocked' } }];
  const segmentChain = [{ ticket: 'T1', gate: 'p5', seq: 1, data: { verdict: 'clear' } }];
  const r = reduceTicketOutcomes([rootChain, segmentChain]);
  assert.equal(r.get('T1').status, 'p5-pass', 'the causally-later segment\'s p5 entry must win over the earlier root prosecution entry');
});
