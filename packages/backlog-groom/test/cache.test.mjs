// cache.test.mjs — AC10, AC16, AC22.
//
// THE DEFECT THIS FILE EXISTS TO PREVENT (spec §4): the cache can reintroduce
// the decay the whole package detects. An issue with no referenced paths has no
// contentHash component; if its key degraded to `updatedAt` alone, a code change
// would never invalidate it — the bug gets fixed, nothing about the issue
// changes, and the cache returns `valid` forever.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contentHash } from '../lib/content-hash.mjs';
import { CACHE_SCHEMA_VERSION, cacheGet, cachePut, cacheKeyFor } from '../lib/cache.mjs';

const files = { 'a.mjs': 'alpha\n', 'b.mjs': 'beta\n', 'c.mjs': 'gamma\n' };
const read = (p) => {
  if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return files[p];
};

test('AC22: contentHash does not depend on the order the parser emitted paths', () => {
  const a = contentHash(['a.mjs', 'b.mjs'], { readFile: read });
  const b = contentHash(['b.mjs', 'a.mjs'], { readFile: read });
  assert.equal(a, b, 'lexicographic ordering makes the hash a property of the SET, not the parse');
});

test('AC22: adding a referenced path changes the hash even though the surviving files are untouched', () => {
  const before = contentHash(['a.mjs', 'b.mjs'], { readFile: read });
  const after = contentHash(['a.mjs', 'b.mjs', 'c.mjs'], { readFile: read });
  assert.notEqual(before, after);
});

test('AC22: removing a referenced path changes the hash too', () => {
  const before = contentHash(['a.mjs', 'b.mjs'], { readFile: read });
  const after = contentHash(['a.mjs'], { readFile: read });
  assert.notEqual(before, after);
});

test('AC22: the path NAME is in the digest — renaming a file with identical bytes changes the hash', () => {
  // Without the name in the digest input, `{a.mjs: "x"}` and `{z.mjs: "x"}`
  // would hash identically, so a rename would look like no change at all.
  const one = contentHash(['a.mjs'], { readFile: () => 'same bytes\n' });
  const two = contentHash(['z.mjs'], { readFile: () => 'same bytes\n' });
  assert.notEqual(one, two);
});

test('AC22: content changes change the hash', () => {
  const before = contentHash(['a.mjs'], { readFile: () => 'one\n' });
  const after = contentHash(['a.mjs'], { readFile: () => 'two\n' });
  assert.notEqual(before, after);
});

test('AC22: a concatenation collision cannot be forged by moving bytes between paths', () => {
  // A naive `path + content` concatenation lets "ab" + "c" collide with
  // "a" + "bc". A length-delimited digest input must not.
  const one = contentHash(['ab.mjs'], { readFile: () => 'c' });
  const two = contentHash(['a.mjs'], { readFile: () => 'bc' });
  assert.notEqual(one, two);
});

test('AC16/AC22: an issue with NO referenced paths has no contentHash', () => {
  assert.equal(contentHash([], { readFile: read }), null, 'null, not the hash of the empty string — there is nothing to key on');
});

test('AC22: an unreadable referenced path yields no hash rather than a hash of nothing', () => {
  // Hashing "" for a missing file would make two different broken states look
  // identical, and would let a cache entry survive the file coming back.
  assert.equal(contentHash(['missing.mjs'], { readFile: read }), null);
});

test('AC16: an issue with no referenced paths is NEVER cached as valid', () => {
  const store = {};
  const entry = { number: 1, verdict: 'valid', route: 'mechanical' };
  cachePut(store, { number: 1, updatedAt: 'T1', contentHash: null }, entry);
  assert.deepEqual(store, {}, 'refusing to store it is what forces a re-verify every run');
});

test('AC16: such an issue may be cached as unverifiable — that verdict cannot go stale into a false green', () => {
  const store = {};
  cachePut(store, { number: 2, updatedAt: 'T1', contentHash: null }, { number: 2, verdict: 'unverifiable', route: 'unverifiable' });
  assert.equal(cacheGet(store, { number: 2, updatedAt: 'T1', contentHash: null })?.verdict, 'unverifiable');
});

test('AC10: a cached issue whose updatedAt changed is re-verified', () => {
  const store = {};
  const key = { number: 3, updatedAt: 'T1', contentHash: 'h1' };
  cachePut(store, key, { number: 3, verdict: 'valid', route: 'mechanical' });
  assert.equal(cacheGet(store, key)?.verdict, 'valid', 'unchanged inputs hit');
  assert.equal(cacheGet(store, { ...key, updatedAt: 'T2' }), null, 'an edited issue must be re-verified');
});

test('AC10: a cached issue whose referenced-path content hash changed is re-verified', () => {
  const store = {};
  const key = { number: 4, updatedAt: 'T1', contentHash: 'h1' };
  cachePut(store, key, { number: 4, verdict: 'valid', route: 'mechanical' });
  assert.equal(cacheGet(store, { ...key, contentHash: 'h2' }), null, 'changed code must be re-verified');
});

test('AC10: a cache MISS never yields valid — it yields nothing', () => {
  const store = {};
  const got = cacheGet(store, { number: 5, updatedAt: 'T1', contentHash: 'h1' });
  assert.equal(got, null, 'a miss is the absence of an answer, not an optimistic one');
});

test('AC10: a corrupt or foreign cache entry is a miss, not a verdict', () => {
  const store = { '6': 'not an object' };
  assert.equal(cacheGet(store, { number: 6, updatedAt: 'T1', contentHash: 'h1' }), null);
  const wrongShape = { '7': { key: 'T1|h1' } };
  assert.equal(cacheGet(wrongShape, { number: 7, updatedAt: 'T1', contentHash: 'h1' }), null, 'an entry with no verdict is not a hit');
});

test('AC10: the cache key is a pure function of (updatedAt, contentHash) and is unambiguous', () => {
  // `updatedAt` and `contentHash` must not be joinable into the same string two
  // different ways, or two distinct issues could share a key.
  assert.notEqual(
    cacheKeyFor({ updatedAt: 'a|b', contentHash: 'c' }),
    cacheKeyFor({ updatedAt: 'a', contentHash: 'b|c' })
  );
});

test('AC10: a null cache entry is a miss, not a crash', () => {
  // JSON nulls are real: a hand-edited or partially-written cache file yields
  // `{"6": null}`. A guard that lets null through reaches `entry.verdict` and
  // throws, taking the whole sweep down over a corrupt cache.
  const store = { 6: null };
  assert.equal(cacheGet(store, { number: 6, updatedAt: 'T1', contentHash: 'h1' }), null);
});

test('AC10: a cache written under an older schema version is a MISS, not a stale verdict', () => {
  // Raised in cross-model review, and it is this package's own failure mode
  // turned inward: an older release stores a wrong verdict, a newer release
  // fixes the verifier, and with unchanged issue text and file bytes the fixed
  // code would never run. The version participates in the key, so an upgrade
  // recomputes rather than inheriting.
  const key = { number: 9, updatedAt: 'T1', contentHash: 'h1' };
  const store = {};
  cachePut(store, key, { verdict: 'valid', route: 'mechanical' });
  const current = store['9'].key;

  const stale = { '9': { verdict: 'valid', route: 'mechanical', key: current.replace(/^v\d+:\d+/, 'v1:1') } };
  assert.equal(cacheGet(stale, key), null, 'an older-version entry must be recomputed');
  assert.equal(cacheGet(store, key)?.verdict, 'valid', 'the current version still hits');
});

test('AC10: the cache schema version is 2 — bumping it discards every existing cache', () => {
  // Pinned deliberately, like the fetch cap. The value is not incidental: raising
  // it invalidates every cache anyone has on disk, so it should move when
  // verdict semantics move and at no other time.
  assert.equal(CACHE_SCHEMA_VERSION, 2);
});

test('AC10: the schema version is part of the key, so two versions cannot collide', () => {
  assert.match(cacheKeyFor({ updatedAt: 'T', contentHash: 'h' }), new RegExp(`^v\\\\d+:${CACHE_SCHEMA_VERSION}\\\\|`));
});

test('AC22: the DEFAULT reader really reads git at a revision — not an injected stub', () => {
  // Every other test injects readFile, so the production path that talks to git
  // was never exercised. Run against this repository's own HEAD, which is the
  // only thing guaranteed to be present wherever this suite runs.
  const real = contentHash(['package.json']);
  assert.match(String(real), /^[0-9a-f]{64}$/, 'a real digest, so the git read returned content');

  const other = contentHash(['package-lock.json']);
  assert.match(String(other), /^[0-9a-f]{64}$/);
  assert.notEqual(real, other, 'two different tracked files must not hash alike');
});

test('AC22: a path absent at the revision yields no hash through the default reader', () => {
  assert.equal(contentHash(['this/path/does/not/exist.mjs']), null);
});

test('AC22: the revision is honoured — an empty tree hashes nothing', () => {
  // The empty-tree object is in every git repository, so this is hermetic. A
  // reader ignoring `revision` would still find package.json at HEAD and return
  // a digest.
  assert.equal(contentHash(['package.json'], { revision: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' }), null);
});

test('AC10: a cache entry claiming an UNKNOWN verdict or route is a miss', () => {
  // The documented contract is that a corrupt cache costs a slow run and never a
  // wrong answer. Checking only "is a string" honoured that contract solely for
  // corruption clumsy enough to drop the field; an entry claiming `fixed!` or an
  // invented route flowed straight through into a close proposal.
  const key = { number: 11, updatedAt: 'T1', contentHash: 'h1' };
  const store = {};
  cachePut(store, key, { verdict: 'valid', route: 'mechanical' });
  const goodKey = store['11'].key;

  for (const entry of [
    { verdict: 'fixed!', route: 'mechanical', key: goodKey },
    { verdict: 'definitely-fixed', route: 'mechanical', key: goodKey },
    { verdict: 'fixed', route: 'invented', key: goodKey },
    { verdict: 'fixed', route: 'mechanical', evidence: 'a string', key: goodKey },
    { verdict: 'fixed', route: 'mechanical', evidence: [], key: goodKey },
  ]) {
    assert.equal(cacheGet({ '11': entry }, key), null, `${JSON.stringify(entry.verdict)} must not be served`);
  }

  assert.equal(cacheGet(store, key)?.verdict, 'valid', 'a well-formed entry still hits');
});

test('AC10: every verdict the verifier can produce is cacheable — including unverified', () => {
  // A missing member would silently make that verdict uncacheable: the entry is
  // written, never served, and the issue is re-verified every run while the
  // cache appears to be working. `unverified` is the model route's verdict, so
  // dropping it would quietly disable caching for that whole route.
  for (const verdict of ['valid', 'fixed', 'moved', 'unverifiable', 'unverified']) {
    const key = { number: 20, updatedAt: 'T1', contentHash: 'h1' };
    const store = {};
    cachePut(store, key, { verdict, route: 'mechanical' });
    assert.equal(cacheGet(store, key)?.verdict, verdict, `${verdict} must round-trip through the cache`);
  }
});

test('AC10: an issue with no updatedAt is never cached — nothing would notice a body edit', () => {
  // contentHash covers the referenced FILES, never the issue body, so updatedAt
  // is the only component that notices a premise being rewritten. Without it the
  // key cannot be invalidated by an edit and the old verdict is served forever.
  const store = {};
  for (const updatedAt of [null, undefined, '']) {
    assert.equal(cachePut(store, { number: 30, updatedAt, contentHash: 'h1' }, { verdict: 'valid', route: 'mechanical' }), false);
  }
  assert.deepEqual(store, {});
  assert.equal(cachePut(store, { number: 30, updatedAt: 'T1', contentHash: 'h1' }, { verdict: 'valid', route: 'mechanical' }), true);
});
