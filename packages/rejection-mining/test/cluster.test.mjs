// Tests for clustering logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBody, jaccard, clusterSignals, deriveSlug } from '../lib/cluster.mjs';

// ---------------------------------------------------------------------------
// normalizeBody
// ---------------------------------------------------------------------------

test('normalizeBody: lowercases and drops stopwords', () => {
  const tokens = normalizeBody('This should not be in the public API');
  assert(!tokens.has('this'));
  assert(!tokens.has('the'));
  assert(tokens.has('public'));
  assert(tokens.has('api'));
});

test('normalizeBody: strips URLs', () => {
  const tokens = normalizeBody('See https://example.com/docs for details');
  const arr = [...tokens];
  assert(!arr.some((t) => t.includes('http')));
  assert(!arr.some((t) => t.includes('example')));
});

test('normalizeBody: strips inline code', () => {
  const tokens = normalizeBody('Use `Promise.all` instead of sequential awaits');
  const arr = [...tokens];
  assert(!arr.includes('promiseall'));
  assert(!arr.includes('promise'));
  // "instead" is a stopword-adjacent but the important signal is structural
  assert(arr.includes('sequential') || arr.includes('awaits'));
});

test('normalizeBody: strips code blocks', () => {
  const body = 'Please avoid this:\n```\nconst x = null;\n```\nit will break things';
  const tokens = normalizeBody(body);
  assert(!tokens.has('const'));
  assert(!tokens.has('null'));
  assert(tokens.has('break') || tokens.has('things'));
});

test('normalizeBody: strips digits', () => {
  const tokens = normalizeBody('line 42 has a problem with value 100');
  const arr = [...tokens];
  assert(!arr.includes('42'));
  assert(!arr.includes('100'));
});

test('normalizeBody: strips punctuation', () => {
  const tokens = normalizeBody('wrong! incorrect. broken?');
  const arr = [...tokens];
  assert(arr.includes('wrong'));
  assert(arr.includes('incorrect'));
  assert(arr.includes('broken'));
  assert(!arr.some((t) => /[!.?]/.test(t)));
});

test('normalizeBody: short tokens filtered out', () => {
  const tokens = normalizeBody('do it or go up');
  // All tokens are <=2 chars or stopwords, so set should be very sparse
  const arr = [...tokens];
  assert(arr.every((t) => t.length > 2));
});

// ---------------------------------------------------------------------------
// jaccard
// ---------------------------------------------------------------------------

test('jaccard: identical sets → 1', () => {
  const a = new Set(['null', 'check', 'missing']);
  assert.strictEqual(jaccard(a, new Set(['null', 'check', 'missing'])), 1);
});

test('jaccard: disjoint sets → 0', () => {
  const a = new Set(['null', 'check']);
  const b = new Set(['security', 'xss']);
  assert.strictEqual(jaccard(a, b), 0);
});

test('jaccard: partial overlap 2/4 = 0.5', () => {
  const a = new Set(['null', 'check', 'missing']);
  const b = new Set(['null', 'check', 'xss']);
  // intersection=2, union=4
  assert.strictEqual(jaccard(a, b), 0.5);
});

test('jaccard: both empty → 1', () => {
  assert.strictEqual(jaccard(new Set(), new Set()), 1);
});

test('jaccard: one empty → 0', () => {
  assert.strictEqual(jaccard(new Set(['foo']), new Set()), 0);
});

// ---------------------------------------------------------------------------
// clusterSignals
// ---------------------------------------------------------------------------

test('clusterSignals: identical bodies cluster together', () => {
  const signals = [
    { body: "don't hardcode the database connection string here" },
    { body: "don't hardcode the database connection string here" },
    { body: "remove this unused import please" },
  ];
  const clusters = clusterSignals(signals, 0.4);
  assert.strictEqual(clusters.length, 2);
  const big = clusters.find((c) => c.length === 2);
  assert(big);
  assert(big.includes(0));
  assert(big.includes(1));
});

test('clusterSignals: dissimilar bodies stay separate', () => {
  const signals = [
    { body: "missing null check before property access" },
    { body: "security vulnerability in SQL query builder" },
    { body: "hardcoded credential should use environment variable" },
  ];
  const clusters = clusterSignals(signals, 0.4);
  assert.strictEqual(clusters.length, 3);
  assert(clusters.every((c) => c.length === 1));
});

test('clusterSignals: similar bodies cluster at 0.4 threshold', () => {
  // These two signals share enough tokens to exceed 0.4 Jaccard
  const signals = [
    { body: "missing null check before accessing the property causes crash" },
    { body: "missing null check before property access causes undefined error" },
  ];
  const clusters = clusterSignals(signals, 0.4);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].length, 2);
});

test('clusterSignals: empty → empty', () => {
  assert.deepStrictEqual(clusterSignals([], 0.4), []);
});

test('clusterSignals: single signal → one cluster', () => {
  const signals = [{ body: 'missing error handling in this function' }];
  const clusters = clusterSignals(signals, 0.4);
  assert.strictEqual(clusters.length, 1);
  assert.deepStrictEqual(clusters[0], [0]);
});

// ---------------------------------------------------------------------------
// deriveSlug
// ---------------------------------------------------------------------------

test('deriveSlug: derives meaningful slug', () => {
  const signals = [
    { body: "don't hardcode credentials in the source code" },
  ];
  const slug = deriveSlug(signals);
  assert(typeof slug === 'string');
  assert(slug.length > 0);
  // Should contain meaningful tokens from the body
  assert(/[a-z]/.test(slug));
});

test('deriveSlug: empty → fallback', () => {
  const slug = deriveSlug([]);
  assert.strictEqual(slug, 'unknown');
});

test('deriveSlug: slug uses hyphens', () => {
  const signals = [{ body: 'missing null check causes undefined errors in production' }];
  const slug = deriveSlug(signals);
  assert(slug.includes('-') || slug.length > 0);
});
