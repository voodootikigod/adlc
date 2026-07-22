// text.test.mjs — tail() and fence() shared text-shaping helpers (issue #280).
// Pure — no I/O, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tail, fence } from '../lib/text.mjs';

// ── tail ─────────────────────────────────────────────────────────────────

test('tail returns the string unchanged when within limit', () => {
  assert.equal(tail('hello', 100), 'hello');
});

test('tail truncates to the LAST maxChars characters', () => {
  const long = 'a'.repeat(5000);
  const result = tail(long, 4000);
  assert.equal(result.length, 4000);
  assert.equal(result, 'a'.repeat(4000));
});

test('tail defaults to 4000 chars', () => {
  const long = 'x'.repeat(6000);
  assert.equal(tail(long).length, 4000);
});

test('tail preserves the END of the string, not the start', () => {
  const str = `${'A'.repeat(10)}${'B'.repeat(10)}`;
  const result = tail(str, 10);
  assert.equal(result, 'B'.repeat(10));
});

// ── fence ────────────────────────────────────────────────────────────────

test('fence requires an explicit maxChars', () => {
  assert.throws(() => fence('LABEL', 'content'), /maxChars must be a non-negative integer/);
});

test('fence rejects a negative maxChars', () => {
  assert.throws(() => fence('LABEL', 'content', -1), /maxChars must be a non-negative integer/);
});

test('fence wraps content in UNTRUSTED/END markers carrying the label', () => {
  const result = fence('BUILD', 'output here', 1000);
  assert.match(result, /^<<UNTRUSTED:BUILD/);
  assert.match(result, /<<END:BUILD:BUILD-11>>$/);
  assert.match(result, /output here/);
});

test('fence leaves short content unmarked as truncated', () => {
  const result = fence('BUILD', 'short', 1000);
  assert.ok(!result.includes('truncated'));
});

test('fence caps content longer than maxChars and marks it truncated', () => {
  const long = 'x'.repeat(5000);
  const result = fence('BUILD', long, 1000);
  assert.match(result, /truncated, showing last 1000 of 5000 chars/);
  // Exactly 1000 x's must appear between the markers, not more.
  const body = result.match(/>>\n([\s\S]*)\n<<END/)[1];
  assert.equal(body.length, 1000);
});

test('fence keeps the TAIL of over-length content (the failure is usually at the end of a log)', () => {
  const content = `${'START'.repeat(200)}${'TAIL_MARKER'}`;
  const result = fence('GATE', content, 20);
  assert.match(result, /TAIL_MARKER/);
  assert.ok(!result.includes('STARTSTART'), 'the beginning of the log must be dropped, not the end');
});

test('fence treats null/undefined content as empty string, not a crash', () => {
  const result = fence('BUILD', undefined, 100);
  assert.match(result, /<<UNTRUSTED:BUILD:BUILD-0>>/);
});

test('fence with maxChars 0 emits an empty body', () => {
  const result = fence('BUILD', 'anything', 0);
  assert.match(result, /<<UNTRUSTED:BUILD \(truncated, showing last 0 of 8 chars\):BUILD-0>>\n\n<<END:BUILD:BUILD-0>>/);
});

test('fence tags differ for different labels with the same content (no cross-label collision)', () => {
  const a = fence('BUILD', 'same', 100);
  const b = fence('GATE', 'same', 100);
  assert.notEqual(a, b);
});
