// capture-textcap.test.mjs — the byte-capping primitive under the capture store
// and the narrative extractor.
//
// Both callers pass it a generous cap, so its edges (a cap of zero, a cap too
// small to hold its own marker, a cut landing mid-character) are reachable only
// through the exported function. They are still contract: this is what "longest
// prefix that fits" and "truncation is never silent" mean at the boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sliceUtf8, truncateUtf8 } from '../lib/text-cap.mjs';

const MARKER = '<<cut>>';

test('sliceUtf8 returns the whole string when it already fits', () => {
  assert.equal(sliceUtf8('abc', 3), 'abc');
  assert.equal(sliceUtf8('abc', 4), 'abc');
  assert.equal(sliceUtf8('', 0), '');
});

test('sliceUtf8 keeps exactly the bytes that fit', () => {
  assert.equal(sliceUtf8('abcdef', 3), 'abc');
  assert.equal(sliceUtf8('abcdef', 1), 'a');
});

test('a cap of zero or less yields nothing, never a stray byte', () => {
  // The guard that makes this true is a clamp, and a clamp is invisible until
  // something asks for a cap at or below its floor.
  assert.equal(sliceUtf8('abc', 0), '');
  assert.equal(sliceUtf8('abc', -1), '');
  assert.equal(sliceUtf8('🙂', 0), '');
});

test('sliceUtf8 never cuts a multi-byte character in half', () => {
  const emoji = '🙂🙂'; // 4 bytes each
  assert.equal(sliceUtf8(emoji, 4), '🙂');
  // A cut mid-sequence walks back to the lead byte rather than emitting U+FFFD.
  for (const cap of [5, 6, 7]) {
    assert.equal(sliceUtf8(emoji, cap), '🙂', `cap ${cap} must not split the second character`);
  }
  assert.equal(sliceUtf8(emoji, 8), emoji);
  assert.equal(sliceUtf8('🙂', 3), '');
});

test('truncateUtf8 leaves anything at or under the cap alone', () => {
  assert.deepEqual(truncateUtf8('abc', { maxBytes: 3, marker: MARKER }), {
    text: 'abc',
    truncated: false,
  });
  assert.deepEqual(truncateUtf8('', { maxBytes: 10, marker: MARKER }), {
    text: '',
    truncated: false,
  });
});

test('truncated text carries the marker INSIDE the cap, not appended past it', () => {
  // 12 bytes into a 10-byte cap, of which the 7-byte marker must be part.
  const capped = truncateUtf8('abcdefghijkl', { maxBytes: 10, marker: MARKER });
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.endsWith(MARKER));
  assert.equal(Buffer.byteLength(capped.text, 'utf8'), 10);
  assert.equal(capped.text, `abc${MARKER}`);
  // Exactly at the cap is not truncation.
  assert.equal(truncateUtf8('abcdefghij', { maxBytes: 10, marker: MARKER }).truncated, false);
});

test('a cap too small for its own marker yields the marker alone', () => {
  // The alternative is silently returning content that claims to be complete —
  // the one outcome this module exists to prevent.
  const capped = truncateUtf8('abcdefghij', { maxBytes: 3, marker: MARKER });
  assert.deepEqual(capped, { text: MARKER, truncated: true });
  assert.deepEqual(truncateUtf8('abcdefghij', { maxBytes: MARKER.length, marker: MARKER }), {
    text: MARKER,
    truncated: true,
  });
});

test('a non-string body is treated as empty rather than stringified', () => {
  for (const input of [null, undefined, 42, {}]) {
    assert.deepEqual(truncateUtf8(input, { maxBytes: 10, marker: MARKER }), {
      text: '',
      truncated: false,
    });
  }
});
