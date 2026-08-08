// Compatibility around isDegraded / computeDepthSignal field names.
// Kept out of depth-signal.test.mjs (frozen by T156 rails).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARD_BYTES, HARD_DEPTH } from '@adlc/context-handoff';
import { computeDepthSignal, isDegraded } from '../lib/depth-signal.mjs';

test('isDegraded accepts computeDepthSignal().bytes (not only sessionBytes)', () => {
  const signal = computeDepthSignal({ text: 'short', bytes: HARD_BYTES });
  assert.equal(signal.bytes, HARD_BYTES);
  assert.equal(isDegraded(signal), true);
  assert.equal(isDegraded({ depth: 0, bytes: HARD_BYTES }), true);
  assert.equal(isDegraded({ depth: HARD_DEPTH - 1, bytes: HARD_BYTES - 1 }), false);
});

test('isDegraded: sessionBytes wins over bytes when both provided', () => {
  assert.equal(isDegraded({ depth: 0, sessionBytes: HARD_BYTES, bytes: 0 }), true);
  assert.equal(isDegraded({ depth: 0, sessionBytes: 0, bytes: HARD_BYTES }), false);
});
