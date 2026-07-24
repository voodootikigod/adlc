// Unit tests for the pure dedupe-bucket helpers (t-herdr-5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, markerName, markerBucket, isStaleMarker } from '../lib/nudge.mjs';

test('bucketFor floors now/window; disabled (null) for a non-positive or non-finite window', () => {
  assert.equal(bucketFor(0, 30_000), 0);
  assert.equal(bucketFor(29_999, 30_000), 0);
  assert.equal(bucketFor(30_000, 30_000), 1);
  assert.equal(bucketFor(61_000, 30_000), 2);
  assert.equal(bucketFor(5, 1), 5); // a 1ms window is VALID (enabled), not disabled
  assert.equal(bucketFor(1000, 0), null); // window 0 → dedupe disabled
  assert.equal(bucketFor(1000, -5), null);
  assert.equal(bucketFor(Infinity, 30_000), null);
});

test('markerName is a stable key-hash with the bucket appended', () => {
  const a = markerName('w1:p1|t-1|idle', 5);
  assert.match(a, /^[0-9a-f]{64}-5$/);
  assert.equal(markerName('w1:p1|t-1|idle', 5), a); // deterministic
  assert.notEqual(markerName('other', 5), a); // key-sensitive
  assert.notEqual(markerName('w1:p1|t-1|idle', 6), a); // bucket-sensitive
});

test('markerBucket parses the trailing bucket, or null for a non-marker name', () => {
  assert.equal(markerBucket(`${'a'.repeat(64)}-7`), 7);
  assert.equal(markerBucket('deadbeef-0'), 0);
  assert.equal(markerBucket('nodash'), null);
  assert.equal(markerBucket('hash-notanumber'), null);
  assert.equal(markerBucket(42), null);
});

test('isStaleMarker is true only for a strictly older bucket', () => {
  const name = (b) => `${'a'.repeat(64)}-${b}`;
  assert.equal(isStaleMarker(name(4), 5), true); // older → stale
  assert.equal(isStaleMarker(name(5), 5), false); // current → keep
  assert.equal(isStaleMarker(name(6), 5), false); // newer → keep
  assert.equal(isStaleMarker('not-a-marker-name', 5), false); // unparsable → keep
});
