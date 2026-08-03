import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBands,
  nagSuppression,
  handoffDenyActive,
  remainingToHard,
  isHardDegraded,
  classifyBandSignal,
} from '../lib/bands.mjs';
import {
  HANDOFF_PCT,
  HARD_PCT,
  HANDOFF_BYTES,
  HARD_DEPTH,
  HARD_BYTES,
  HANDOFF_COOLDOWN_TOOLS,
} from '../lib/thresholds.mjs';

test('absolute OR-join: depth past handoff fires even if pct does not', () => {
  const b = evaluateBands({ pct: 40, depth: 30, bytes: 1000 });
  assert.equal(b.warn, true);
  assert.equal(b.handoff, true);
  assert.equal(b.hard, false);
});

test('absolute OR-join: bytes past handoff fires even if pct is low', () => {
  const b = evaluateBands({ pct: 10, depth: 1, bytes: HANDOFF_BYTES });
  assert.equal(b.handoff, true);
  assert.equal(b.hard, false);
});

test('absent signals ignored; present malformed fail closed as hard', () => {
  const missing = evaluateBands({ pct: 10 });
  assert.equal(missing.hard, false);
  assert.equal(evaluateBands({}).hard, false);
  assert.equal(evaluateBands({ pct: null, depth: undefined }).hard, false);

  for (const observed of [
    { pct: NaN },
    { depth: Infinity },
    { bytes: -Infinity },
    { pct: '99' },
    { bytes: '100000' },
  ]) {
    const b = evaluateBands(observed);
    assert.equal(b.warn, true, JSON.stringify(observed));
    assert.equal(b.handoff, true, JSON.stringify(observed));
    assert.equal(b.hard, true, JSON.stringify(observed));
    assert.equal(isHardDegraded(observed), true, JSON.stringify(observed));
  }
});

test('no floor-delta: absolute bands ignore a floor field on observed', () => {
  // Killer for floor-delta mutants: high floor must not pull absolute 65% below handoff.
  const b = evaluateBands({ pct: 65, floor: 40 });
  assert.equal(b.handoff, true);
  assert.equal(b.hard, false);
  assert.ok(65 >= HANDOFF_PCT && 65 < HARD_PCT);
  // remainingToHard(floor) is a separate nag-only path, not a band comparator.
  assert.equal(remainingToHard({ pct: 35 }), (HARD_PCT - 35) / HARD_PCT);
});

test('isHardDegraded follows absolute hard OR-join', () => {
  assert.equal(isHardDegraded({ pct: 79 }), false);
  assert.equal(isHardDegraded({ pct: HARD_PCT }), true);
});

test('remaining-to-hard uses HARD_PCT ceiling', () => {
  assert.equal(remainingToHard({ pct: 40 }), (HARD_PCT - 40) / HARD_PCT);
});

test('headroom/cooldown suppress nags only — deny still follows absolute handoff', () => {
  const bands = evaluateBands({ pct: 65 });
  assert.equal(bands.handoff, true);
  assert.ok(65 >= HANDOFF_PCT && 65 < HARD_PCT);
  const nags = nagSuppression({ floor: { pct: 65 }, toolsSinceResume: 100 });
  assert.equal(nags.suppressNags, true);
  assert.equal(
    nags.reason,
    'near-hard headroom: advisory nags deferred to deny',
  );
  assert.equal(handoffDenyActive(bands, nags), true, 'deny must ignore nag suppression');
});

test('near-hard floor suppresses nags; healthy headroom alone does not', () => {
  // pct=65 handoff zone: rem=(80-65)/80=0.1875 < MIN_REMAINING_TO_HARD → suppress
  const nearHard = nagSuppression({ floor: { pct: 65 }, toolsSinceResume: 100 });
  assert.equal(nearHard.suppressNags, true);
  assert.equal(
    nearHard.reason,
    'near-hard headroom: advisory nags deferred to deny',
  );

  // pct=40 healthy: rem=(80-40)/80=0.5 ≥ 0.25 → headroom alone does not suppress
  // (cooldown cleared via toolsSinceResume ≥ HANDOFF_COOLDOWN_TOOLS)
  const healthy = nagSuppression({ floor: { pct: 40 }, toolsSinceResume: 100 });
  assert.equal(healthy.suppressNags, false);
  assert.equal(healthy.reason, 'nags allowed');
  // cooldown may still suppress when toolsSinceResume is low
  const cooldown = nagSuppression({ floor: { pct: 40 }, toolsSinceResume: 0 });
  assert.equal(cooldown.suppressNags, true);
  assert.equal(cooldown.reason, 'post-resume cooldown');
});

test('handoffDenyActive false when below handoff even if nags suppressed', () => {
  const bands = evaluateBands({ pct: 10 });
  assert.equal(bands.handoff, false);
  const nags = nagSuppression({ floor: { pct: 10 }, toolsSinceResume: 0 });
  assert.equal(nags.suppressNags, true);
  assert.equal(handoffDenyActive(bands, nags), false);
});

test('cooldown suppresses nags but not deny', () => {
  const bands = evaluateBands({ pct: 70 });
  const nags = nagSuppression({
    floor: { pct: 10 },
    toolsSinceResume: 0,
    cooldownTools: HANDOFF_COOLDOWN_TOOLS,
  });
  assert.equal(nags.suppressNags, true);
  assert.equal(handoffDenyActive(bands, nags), true);
});

test('hard OR-join via depth and bytes', () => {
  assert.equal(evaluateBands({ pct: 10, depth: HARD_DEPTH }).hard, true);
  assert.equal(isHardDegraded({ pct: 10, depth: HARD_DEPTH }), true);
  assert.equal(evaluateBands({ pct: 10, bytes: HARD_BYTES }).hard, true);
  assert.equal(isHardDegraded({ pct: 10, bytes: HARD_BYTES }), true);
});

test('non-object observed payloads fail closed as hard (no throw)', () => {
  for (const observed of [null, '99', [90], 42, true]) {
    const b = evaluateBands(observed);
    assert.equal(b.hard, true, JSON.stringify(observed));
    assert.equal(isHardDegraded(observed), true, JSON.stringify(observed));
  }
});

test('exact HARD_* thresholds are inclusive (in-band)', () => {
  assert.equal(isHardDegraded({ pct: HARD_PCT }), true);
  assert.equal(isHardDegraded({ depth: HARD_DEPTH }), true);
  assert.equal(isHardDegraded({ bytes: HARD_BYTES }), true);
  assert.equal(evaluateBands({ pct: HARD_PCT - 1 }).hard, false);
});

test('remainingToHard fails closed on non-finite floor signals', () => {
  assert.equal(remainingToHard({ pct: NaN }), 0);
  assert.equal(remainingToHard({ depth: Infinity }), 0);
  assert.equal(remainingToHard({ bytes: '100' }), 0);
  assert.equal(remainingToHard(null), 0);
});

test('remainingToHard treats out-of-domain finite floors as depleted', () => {
  assert.equal(remainingToHard({ pct: -1 }), 0);
  assert.equal(remainingToHard({ pct: 101 }), 0);
  assert.equal(remainingToHard({ depth: -5 }), 0);
  assert.equal(remainingToHard({ bytes: -1 }), 0);
  // Near-hard suppress still uses in-domain remaining; domain mismatch → depleted.
  const nags = nagSuppression({ floor: { pct: 101 }, toolsSinceResume: 100 });
  assert.equal(nags.suppressNags, true);
});

test('out-of-domain finite signals fail closed as hard', () => {
  assert.equal(isHardDegraded({ pct: -1 }), true);
  assert.equal(isHardDegraded({ pct: 101 }), true);
  assert.equal(isHardDegraded({ depth: -5 }), true);
  assert.equal(isHardDegraded({ bytes: -1 }), true);
});


test('pct 100 inclusive hard, 100.1 invalid hard; depth 0 is not hard alone', () => {
  assert.equal(isHardDegraded({ pct: 100 }), true);
  assert.equal(isHardDegraded({ pct: 100.1 }), true);
  assert.equal(evaluateBands({ depth: 0 }).hard, false);
  assert.equal(evaluateBands({ depth: 0 }).warn, false);
});


test('classifyBandSignal marks NaN/Infinity/non-numbers invalid (not absent)', () => {
  assert.equal(classifyBandSignal(undefined), 'absent');
  assert.equal(classifyBandSignal(null), 'absent');
  assert.equal(classifyBandSignal(NaN), 'invalid');
  assert.equal(classifyBandSignal(Infinity), 'invalid');
  assert.equal(classifyBandSignal(-Infinity), 'invalid');
  assert.equal(classifyBandSignal('99'), 'invalid');
  assert.equal(classifyBandSignal(40), 'number');
});
