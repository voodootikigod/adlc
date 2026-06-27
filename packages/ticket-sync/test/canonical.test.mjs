import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, canonicalEqual, canonicalHash, normalizeNewlines } from '../lib/canonical.mjs';

test('sorts object keys recursively', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalize({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('key order does not affect equality', () => {
  assert.ok(canonicalEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
});

test('array order IS significant', () => {
  assert.ok(!canonicalEqual({ a: [1, 2] }, { a: [2, 1] }));
});

test('number forms normalize (2e5 === 200000)', () => {
  assert.ok(canonicalEqual({ budget: 2e5 }, { budget: 200000 }));
});

test('omit drops a key at any depth (e.g. $schema)', () => {
  assert.equal(canonicalize({ $schema: 'x', a: 1 }, { omit: ['$schema'] }), '{"a":1}');
  assert.ok(canonicalEqual({ $schema: 'a', scope: ['s'] }, { $schema: 'b', scope: ['s'] }, { omit: ['$schema'] }));
});

test('canonicalHash is stable across key order', () => {
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('normalizeNewlines collapses CRLF and CR to LF', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('normalizeNewlines coerces non-string input via String()', () => {
  assert.equal(normalizeNewlines(123), '123');
  assert.equal(normalizeNewlines(null), 'null');
});
