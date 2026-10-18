import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson as coreCanonicalJson, sha256 as coreSha256 } from '@adlc/core';
import { canonicalBytes, canonicalHash, canonicalJson, sha256 } from '../lib/canonical.mjs';

test('re-exports canonicalJson and sha256 from @adlc/core with exact identity and parity', () => {
  assert.equal(canonicalJson, coreCanonicalJson);
  assert.equal(sha256, coreSha256);

  const sample = { z: [3, { b: 'two', a: 'one' }], a: true, m: null };
  assert.equal(canonicalJson(sample), coreCanonicalJson(sample));
  assert.equal(sha256('abc'), coreSha256('abc'));
});

test('canonicalJson sorts object keys at every depth while preserving array element order', () => {
  const first = {
    z: 1,
    a: { d: 4, c: [{ y: 2, x: 1 }, { b: 0, a: 9 }] },
    m: [3, 1, 2],
  };
  const second = {
    a: { c: [{ x: 1, y: 2 }, { a: 9, b: 0 }], d: 4 },
    m: [3, 1, 2],
    z: 1,
  };

  const expected = '{"a":{"c":[{"x":1,"y":2},{"a":9,"b":0}],"d":4},"m":[3,1,2],"z":1}';
  assert.equal(canonicalJson(first), expected);
  assert.equal(canonicalJson(second), expected);
});

test('canonicalJson handles primitives, null, and empty containers', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(false), 'false');
  assert.equal(canonicalJson(0), '0');
  assert.equal(canonicalJson(-42), '-42');
  assert.equal(canonicalJson('hello'), '"hello"');
  assert.equal(canonicalJson([]), '[]');
  assert.equal(canonicalJson({}), '{}');
});

test('canonicalHash returns a 64-char hex sha256 digest of the canonical JSON', () => {
  const a = { b: 2, a: 1, nested: [{ d: 'x', c: 'y' }] };
  const b = { nested: [{ c: 'y', d: 'x' }], a: 1, b: 2 };

  const digest = canonicalHash(a);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, canonicalHash(b));
  assert.equal(digest, coreSha256(coreCanonicalJson(a)));
  assert.notEqual(digest, canonicalHash({ a: 1, b: 3, nested: [{ c: 'y', d: 'x' }] }));
});

test('canonicalBytes measures UTF-8 byte length of the canonical JSON including multi-byte characters', () => {
  const ascii = { b: 'hi', a: 1 };
  assert.equal(canonicalBytes(ascii), 16);
  assert.equal(canonicalBytes({ a: 1, b: 'hi' }), 16);

  // 'é' = 2 UTF-8 bytes (1 UTF-16 code unit), '€' = 3 UTF-8 bytes (1 code unit), '🚀' = 4 UTF-8 bytes (2 code units)
  const multibyte = { rocket: '🚀', euro: '€', accent: 'é' };
  const serialized = coreCanonicalJson(multibyte);
  assert.equal(serialized, '{"accent":"é","euro":"€","rocket":"🚀"}');
  assert.equal(serialized.length, 39);
  assert.equal(canonicalBytes(multibyte), 44);
  assert.equal(canonicalBytes(multibyte), Buffer.byteLength(serialized, 'utf8'));
});
