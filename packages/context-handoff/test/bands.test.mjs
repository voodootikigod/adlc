import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateBands,
  nagSuppression,
  handoffDenyActive,
  remainingToHard,
  isHardDegraded,
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
  assert.equal(handoffDenyActive(bands, nags), true, 'deny must ignore nag suppression');
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
