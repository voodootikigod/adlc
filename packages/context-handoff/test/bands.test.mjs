import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBands, nagSuppression, handoffDenyActive, remainingToHard } from '../lib/bands.mjs';
import { HANDOFF_PCT, HARD_PCT } from '../lib/thresholds.mjs';

test('absolute OR-join: depth past handoff fires even if pct does not', () => {
  const b = evaluateBands({ pct: 40, depth: 30, bytes: 1000 });
  assert.equal(b.warn, true);
  assert.equal(b.handoff, true);
  assert.equal(b.hard, false);
});

test('compacted forces hard', () => {
  assert.equal(evaluateBands({ pct: 10, compacted: true }).hard, true);
});

test('no floor-delta: high floor does not change absolute band compare', () => {
  // Floor is unused by evaluateBands — absolute 65% is handoff regardless of floor 35.
  const b = evaluateBands({ pct: 65 });
  assert.equal(b.handoff, true);
  assert.equal(b.hard, false);
});

test('remaining-to-hard uses HARD_PCT ceiling', () => {
  assert.equal(remainingToHard({ pct: 40 }), (HARD_PCT - 40) / HARD_PCT);
});

test('headroom/cooldown suppress nags only — deny still follows absolute handoff', () => {
  const bands = evaluateBands({ pct: 65 }); // ≥ handoff, < hard
  assert.equal(bands.handoff, true);

  // Floor in [handoff, hard) ⇒ remaining-to-hard < 0.25 ⇒ nags suppressed
  assert.ok(65 >= HANDOFF_PCT && 65 < HARD_PCT);
  const nags = nagSuppression({ floor: { pct: 65 }, toolsSinceResume: 100 });
  assert.equal(nags.suppressNags, true);

  assert.equal(handoffDenyActive(bands, nags), true, 'deny must ignore nag suppression');
});

test('cooldown suppresses nags but not deny', () => {
  const bands = evaluateBands({ pct: 70 });
  const nags = nagSuppression({ floor: { pct: 10 }, toolsSinceResume: 0, cooldownTools: 15 });
  assert.equal(nags.suppressNags, true);
  assert.equal(handoffDenyActive(bands, nags), true);
});
