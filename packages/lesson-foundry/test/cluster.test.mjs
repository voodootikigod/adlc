// Tests for clustering math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDesc, jaccard, clusterFindings } from '../lib/cluster.mjs';

// ---------------------------------------------------------------------------
// normalizeDesc
// ---------------------------------------------------------------------------
test('normalizeDesc: lowercases and removes stopwords', () => {
  const tokens = normalizeDesc('The function is broken and needs fixing');
  assert(!tokens.has('the'));
  assert(!tokens.has('and'));
  assert(!tokens.has('is'));
  assert(tokens.has('function'));
  assert(tokens.has('broken'));
  assert(tokens.has('fixing'));
});

test('normalizeDesc: strips file paths', () => {
  const tokens = normalizeDesc('Error in src/utils/helper.ts at line 42');
  // Path should be gone
  const arr = [...tokens];
  assert(!arr.some((t) => t.includes('/')));
  assert(!arr.some((t) => t.includes('\\')));
});

test('normalizeDesc: strips digits', () => {
  const tokens = normalizeDesc('Variable count123 at line 42 is wrong');
  const arr = [...tokens];
  // stand-alone 42 should be gone; count123 may remain as token with mixed alphanum
  assert(!arr.includes('42'));
});

test('normalizeDesc: strips quoted literals', () => {
  const tokens = normalizeDesc('Use "foo bar" instead of "baz"');
  const arr = [...tokens];
  assert(!arr.includes('foo'));
  assert(!arr.includes('bar'));
  assert(!arr.includes('baz'));
});

test('normalizeDesc: strips punctuation', () => {
  const tokens = normalizeDesc('missing semicolon; bad comma, wrong!');
  const arr = [...tokens];
  assert(!arr.includes(';'));
  assert(!arr.includes(','));
  assert(!arr.includes('!'));
});

// ---------------------------------------------------------------------------
// jaccard
// ---------------------------------------------------------------------------
test('jaccard: identical sets → 1', () => {
  const a = new Set(['foo', 'bar', 'baz']);
  assert.strictEqual(jaccard(a, new Set(['foo', 'bar', 'baz'])), 1);
});

test('jaccard: disjoint sets → 0', () => {
  const a = new Set(['foo', 'bar']);
  const b = new Set(['baz', 'qux']);
  assert.strictEqual(jaccard(a, b), 0);
});

test('jaccard: partial overlap', () => {
  const a = new Set(['foo', 'bar', 'baz']);
  const b = new Set(['foo', 'bar', 'qux']);
  // intersection=2, union=4 → 0.5
  assert.strictEqual(jaccard(a, b), 0.5);
});

test('jaccard: both empty → 1 (vacuously identical)', () => {
  assert.strictEqual(jaccard(new Set(), new Set()), 1);
});

test('jaccard: one empty → 0', () => {
  assert.strictEqual(jaccard(new Set(['foo']), new Set()), 0);
});

// ---------------------------------------------------------------------------
// clusterFindings
// ---------------------------------------------------------------------------
test('clusterFindings: identical descs cluster together', () => {
  const findings = [
    { desc: 'missing null check in database query' },
    { desc: 'missing null check in database query' },
    { desc: 'totally unrelated issue with memory' },
  ];
  const clusters = clusterFindings(findings, 0.5);
  // First two should be in same cluster, third separate
  assert.strictEqual(clusters.length, 2);
  const bigCluster = clusters.find((c) => c.length === 2);
  assert(bigCluster);
  assert(bigCluster.includes(0));
  assert(bigCluster.includes(1));
});

test('clusterFindings: different descs stay separate', () => {
  const findings = [
    { desc: 'missing null check in query' },
    { desc: 'SQL injection vulnerability in login form' },
    { desc: 'XSS vulnerability in template rendering' },
  ];
  const clusters = clusterFindings(findings, 0.5);
  // Each should be its own cluster
  assert.strictEqual(clusters.length, 3);
  assert(clusters.every((c) => c.length === 1));
});

test('clusterFindings: similar but not identical descs cluster at 0.5 threshold', () => {
  const findings = [
    { desc: 'missing null check before accessing property' },
    { desc: 'null check missing before property access' },
  ];
  const clusters = clusterFindings(findings, 0.5);
  // Should cluster together (high Jaccard)
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].length, 2);
});

test('clusterFindings: empty findings returns empty array', () => {
  assert.deepStrictEqual(clusterFindings([], 0.5), []);
});

test('clusterFindings: single finding returns one cluster', () => {
  const findings = [{ desc: 'some issue' }];
  const clusters = clusterFindings(findings, 0.5);
  assert.strictEqual(clusters.length, 1);
  assert.deepStrictEqual(clusters[0], [0]);
});

test('clusterFindings: transitive merging works', () => {
  // A~B and B~C → all three in same cluster even if A!~C
  const findings = [
    { desc: 'null check missing in function call parameter' },
    { desc: 'null check missing in function argument' },
    { desc: 'missing null check argument function input' },
  ];
  const clusters = clusterFindings(findings, 0.3);
  // Should all be in one cluster at lower threshold
  const big = clusters.find((c) => c.length === 3);
  assert(big, 'expected all three to cluster together at threshold 0.3');
});
