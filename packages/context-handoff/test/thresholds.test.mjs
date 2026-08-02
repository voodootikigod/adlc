import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WARN_PCT,
  HANDOFF_PCT,
  HARD_PCT,
  WARN_DEPTH,
  HANDOFF_DEPTH,
  HARD_DEPTH,
  WARN_BYTES,
  HANDOFF_BYTES,
  HARD_BYTES,
  thresholdsOrdered,
} from '../lib/thresholds.mjs';

test('warn < handoff < hard for pct, depth, and bytes', () => {
  assert.equal(thresholdsOrdered(), true);
  assert.ok(WARN_PCT < HANDOFF_PCT && HANDOFF_PCT < HARD_PCT);
  assert.ok(WARN_DEPTH < HANDOFF_DEPTH && HANDOFF_DEPTH < HARD_DEPTH);
  assert.ok(WARN_BYTES < HANDOFF_BYTES && HANDOFF_BYTES < HARD_BYTES);
});

test('defaults match approved spec table', () => {
  assert.equal(WARN_PCT, 50);
  assert.equal(HANDOFF_PCT, 60);
  assert.equal(HARD_PCT, 80);
  assert.equal(WARN_DEPTH, 20);
  assert.equal(HANDOFF_DEPTH, 30);
  assert.equal(HARD_DEPTH, 40);
  assert.equal(WARN_BYTES, 128 * 1024);
  assert.equal(HANDOFF_BYTES, 192 * 1024);
  assert.equal(HARD_BYTES, 256 * 1024);
});
