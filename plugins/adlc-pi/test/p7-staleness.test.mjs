// #936 — computeP7StaleDays boundary coverage (mutation-gate kills).
// These pin the default threshold (14d) and the entry-type set so an
// off-by-one on the constant or a shrink of the types array is observable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeP7StaleDays, P7_STALE_DEFAULT_DAYS } from '../lib/extension.mjs';

const DAY = 86_400_000;
const now = Date.parse('2026-08-04T00:00:00Z');

test('default threshold is 14 days and the boundary is exclusive (14 = fresh)', () => {
  assert.equal(P7_STALE_DEFAULT_DAYS, 14, 'the documented default threshold');
  const atBoundary = [{ type: 'lesson-foundry', at: new Date(now - 14 * DAY).toISOString() }];
  assert.equal(computeP7StaleDays(atBoundary, { now }), null, 'exactly 14 days old is not yet stale');
  const pastBoundary = [{ type: 'lesson-foundry', at: new Date(now - 15 * DAY).toISOString() }];
  assert.equal(computeP7StaleDays(pastBoundary, { now }), 15, '15 days old reports 15');
});

test('skill-rot entries count toward staleness (types-set shrink kill)', () => {
  const skillRotOnly = [{ type: 'skill-rot', at: new Date(now - 30 * DAY).toISOString() }];
  assert.equal(computeP7StaleDays(skillRotOnly, { now }), 30, 'a skill-rot entry drives the clock');
});

test('non-P7 gates (preflight, hollow-test) do not reset the clock', () => {
  const nonP7 = [
    { type: 'preflight', at: new Date(now - 1 * DAY).toISOString() },
    { type: 'hollow-test', at: new Date(now).toISOString() },
  ];
  assert.equal(computeP7StaleDays(nonP7, { now }), null);
});

test('mixed: latest P7 entry wins over older P7 entries; malformed entries ignored', () => {
  const mixed = [
    { type: 'lesson-foundry', at: new Date(now - 60 * DAY).toISOString() },
    { type: 'lesson-foundry', at: 'not-a-date' },
    { type: 'lesson-foundry' },
    null,
    { type: 'skill-rot', at: new Date(now - 20 * DAY).toISOString() },
  ];
  assert.equal(computeP7StaleDays(mixed, { now }), 20, 'latest valid P7 timestamp drives');
});

test('threshold override: a custom threshold flips the boundary', () => {
  const at = [{ type: 'lesson-foundry', at: new Date(now - 7 * DAY).toISOString() }];
  assert.equal(computeP7StaleDays(at, { now, thresholdDays: 7 }), null, '7 < default but exactly at custom 7');
  assert.equal(computeP7StaleDays(at, { now, thresholdDays: 6 }), 7, 'crosses a 6-day custom threshold');
});

test('empty or absent entries → null (no evidence, no hint)', () => {
  assert.equal(computeP7StaleDays([], { now }), null);
  assert.equal(computeP7StaleDays(null, { now }), null);
  assert.equal(computeP7StaleDays(undefined, { now }), null);
});
