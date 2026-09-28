// cache-code-binding.test.mjs — a verdict with no code component in its key.
//
// contentHash is null whenever any cited path cannot be read at the revision,
// which includes every issue quoting a path this repository never had. A key
// with no contentHash is keyed on `updatedAt` alone, so no code change can ever
// invalidate it. That is as true of `fixed` as of `valid` — and for `fixed` the
// stale direction is the dangerous one: the report keeps saying "fixed" after
// the cited code comes back.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cacheGet, cachePut, cacheKeyFor, CACHE_SCHEMA_VERSION } from '../lib/cache.mjs';
import { groom } from '../lib/groom.mjs';
import { parseProfile } from '../lib/profile.mjs';

const key = { number: 1, updatedAt: 'T1', contentHash: null };

for (const verdict of ['valid', 'fixed', 'moved']) {
  test(`a ${verdict} verdict with no contentHash is not stored`, () => {
    const store = {};
    assert.equal(cachePut(store, key, { route: 'mechanical', verdict, evidence: null, verifiedPaths: [] }), false);
    assert.deepEqual(store, {});
  });

  test(`a ${verdict} entry with no contentHash already on disk is a miss`, () => {
    const store = { 1: { route: 'mechanical', verdict, evidence: null, verifiedPaths: [], key: cacheKeyFor(key) } };
    assert.equal(cacheGet(store, key), null);
  });
}

for (const verdict of ['unverifiable', 'unverified']) {
  test(`${verdict} may still be cached without a contentHash`, () => {
    const store = {};
    assert.equal(cachePut(store, key, { route: 'mechanical', verdict, evidence: null, verifiedPaths: [] }), true);
    assert.equal(cacheGet(store, key).verdict, verdict);
  });
}

test('a verdict with a contentHash is cached with its verified locations', () => {
  const store = {};
  const k = { number: 2, updatedAt: 'T1', contentHash: 'abc' };
  assert.equal(cachePut(store, k, { route: 'mechanical', verdict: 'fixed', evidence: {}, verifiedPaths: ['a.mjs'] }), true);
  assert.deepEqual(cacheGet(store, k).verifiedPaths, ['a.mjs']);
});

test('an entry whose verifiedPaths is not a list of strings is a miss', () => {
  const k = { number: 3, updatedAt: 'T1', contentHash: 'abc' };
  for (const bad of [undefined, 'a.mjs', [1], null]) {
    const store = { 3: { route: 'mechanical', verdict: 'valid', verifiedPaths: bad, key: cacheKeyFor(k) } };
    assert.equal(cacheGet(store, k), null, `verifiedPaths ${JSON.stringify(bad)} must not be served`);
  }
});

test('the schema version moved with the entry shape', () => {
  assert.ok(CACHE_SCHEMA_VERSION >= 3);
});

test('end to end: a revert restoring the cited code is seen on the next cached run', () => {
  const PROFILE = parseProfile({ schemaVersion: 1 });
  const body = [
    'Cites `lib/from-other-repo.mjs` and **Location** `packages/core/lib/text.mjs:3`',
    '',
    '```',
    'const tag = one;',
    '```',
  ].join('\n');
  const io = (content) => ({
    headCommit: () => 'a'.repeat(40),
    fetchIssues: () => ({ truncated: null, unconsultable: null, issues: [{ number: 1, title: 't', body, labels: [], url: 'u', updatedAt: 'T1' }] }),
    readFile: (p) => {
      if (p !== 'packages/core/lib/text.mjs') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    },
    pathKind: (p) => (p === 'packages/core/lib/text.mjs' ? 'blob' : null),
    lastCommitFor: () => 'abc',
    everExisted: (p) => p === 'packages/core/lib/text.mjs',
  });
  const cache = {};
  const first = groom({ profile: PROFILE, cache, io: io('something else\n') });
  assert.equal(first.set.issues[0].verdict, 'fixed');
  const second = groom({ profile: PROFILE, cache, io: io('const tag = one;\n') });
  assert.equal(second.set.issues[0].verdict, 'valid', 'the restored code must not be hidden behind a cached fixed');
});
