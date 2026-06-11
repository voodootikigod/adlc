// Tests for report.mjs — buildHumanReport and buildJsonResult.
// Pure function tests; no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHumanReport, buildJsonResult } from '../lib/report.mjs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeCluster(overrides = {}) {
  return {
    slug: 'avoid-hardcoding',
    title: null,
    count: 3,
    prNumbers: new Set([1, 2, 3]),
    indices: [0, 1, 2],
    ...overrides,
  };
}

function makePlan(overrides = {}) {
  return {
    slug: 'avoid-hardcoding',
    path: '.aidlc/lenses/lens-avoid-hardcoding.md',
    content: '# Lens: Avoid Hardcoding',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildHumanReport — header / summary section
// ---------------------------------------------------------------------------

test('buildHumanReport: returns an array of strings', () => {
  const lines = buildHumanReport({
    clusters: [],
    lensPlans: [],
    totalSignals: 0,
    totalPRs: 5,
    skippedPRs: 0,
  });
  assert(Array.isArray(lines));
  assert(lines.every((l) => typeof l === 'string'));
});

test('buildHumanReport: includes PRs scanned and signals found', () => {
  const lines = buildHumanReport({
    clusters: [],
    lensPlans: [],
    totalSignals: 7,
    totalPRs: 10,
    skippedPRs: 0,
  });
  const text = lines.join('\n');
  assert(text.includes('10'));
  assert(text.includes('7'));
});

test('buildHumanReport: shows skipped PRs line only when skippedPRs > 0', () => {
  const withSkipped = buildHumanReport({
    clusters: [],
    lensPlans: [],
    totalSignals: 0,
    totalPRs: 5,
    skippedPRs: 2,
  }).join('\n');
  assert(withSkipped.includes('skipped') || withSkipped.includes('2'));

  const noSkipped = buildHumanReport({
    clusters: [],
    lensPlans: [],
    totalSignals: 0,
    totalPRs: 5,
    skippedPRs: 0,
  }).join('\n');
  // skippedPRs=0 → should NOT have a "skipped" line
  assert(!noSkipped.toLowerCase().includes('skipped'));
});

test('buildHumanReport: no clusters → shows "No clusters met" message', () => {
  const lines = buildHumanReport({
    clusters: [],
    lensPlans: [],
    totalSignals: 0,
    totalPRs: 3,
    skippedPRs: 0,
  });
  const text = lines.join('\n');
  assert(text.toLowerCase().includes('no clusters'));
});

test('buildHumanReport: reports Lenses count equal to clusters.length', () => {
  const clusters = [makeCluster(), makeCluster({ slug: 'other', prNumbers: new Set([4]) })];
  const lensPlans = [makePlan(), makePlan({ slug: 'other', path: '.aidlc/lenses/lens-other.md' })];
  const text = buildHumanReport({
    clusters,
    lensPlans,
    totalSignals: 5,
    totalPRs: 4,
    skippedPRs: 0,
  }).join('\n');
  // "Lenses: 2" should appear somewhere
  assert(text.includes('2'));
});

// ---------------------------------------------------------------------------
// buildHumanReport — table body
// ---------------------------------------------------------------------------

test('buildHumanReport: table row uses cluster slug when title is null', () => {
  const cluster = makeCluster({ title: null, slug: 'avoid-hardcoding' });
  const plan = makePlan();
  const text = buildHumanReport({
    clusters: [cluster],
    lensPlans: [plan],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  }).join('\n');
  assert(text.includes('avoid-hardcoding'));
});

test('buildHumanReport: table row uses LLM title when provided', () => {
  const cluster = makeCluster({ title: 'Hardcoded Secrets' });
  const plan = makePlan();
  const text = buildHumanReport({
    clusters: [cluster],
    lensPlans: [plan],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  }).join('\n');
  assert(text.includes('Hardcoded Secrets'));
});

test('buildHumanReport: table row includes lens file path', () => {
  const cluster = makeCluster();
  const plan = makePlan({ path: '.aidlc/lenses/lens-avoid-hardcoding.md' });
  const text = buildHumanReport({
    clusters: [cluster],
    lensPlans: [plan],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  }).join('\n');
  assert(text.includes('.aidlc/lenses/lens-avoid-hardcoding.md'));
});

test('buildHumanReport: shows dry-run marker when plan is null', () => {
  const cluster = makeCluster();
  // lensPlans[0] = undefined simulates no plan emitted
  const text = buildHumanReport({
    clusters: [cluster],
    lensPlans: [undefined],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  }).join('\n');
  assert(text.includes('dry-run') || text.includes('('));
});

test('buildHumanReport: multiple clusters each appear as table rows', () => {
  const clusters = [
    makeCluster({ slug: 'avoid-hardcoding', title: 'Avoid Hardcoding', prNumbers: new Set([1]) }),
    makeCluster({ slug: 'missing-null-check', title: 'Missing Null Check', prNumbers: new Set([2]) }),
  ];
  const lensPlans = [
    makePlan({ slug: 'avoid-hardcoding' }),
    makePlan({ slug: 'missing-null-check', path: '.aidlc/lenses/lens-missing-null-check.md' }),
  ];
  const text = buildHumanReport({
    clusters,
    lensPlans,
    totalSignals: 4,
    totalPRs: 2,
    skippedPRs: 0,
  }).join('\n');
  assert(text.includes('Avoid Hardcoding'));
  assert(text.includes('Missing Null Check'));
});

// ---------------------------------------------------------------------------
// buildJsonResult — structure
// ---------------------------------------------------------------------------

test('buildJsonResult: returns a plain object (not an array)', () => {
  const result = buildJsonResult({
    clusters: [],
    lensPlans: [],
    totalSignals: 0,
    totalPRs: 0,
    skippedPRs: 0,
  });
  assert(result !== null && typeof result === 'object' && !Array.isArray(result));
});

test('buildJsonResult: top-level fields present', () => {
  const result = buildJsonResult({
    clusters: [],
    lensPlans: [],
    totalSignals: 5,
    totalPRs: 10,
    skippedPRs: 1,
  });
  assert.strictEqual(result.totalPRs, 10);
  assert.strictEqual(result.skippedPRs, 1);
  assert.strictEqual(result.totalSignals, 5);
  assert.strictEqual(result.lensCount, 0);
  assert(Array.isArray(result.lenses));
  assert.strictEqual(result.lenses.length, 0);
});

test('buildJsonResult: lensCount equals clusters.length', () => {
  const clusters = [makeCluster()];
  const lensPlans = [makePlan()];
  const result = buildJsonResult({
    clusters,
    lensPlans,
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  });
  assert.strictEqual(result.lensCount, 1);
});

test('buildJsonResult: each lens entry has required fields', () => {
  const cluster = makeCluster({ slug: 'avoid-hardcoding', title: null, count: 3, prNumbers: new Set([1, 2, 3]) });
  const plan = makePlan({ path: '.aidlc/lenses/lens-avoid-hardcoding.md' });
  const result = buildJsonResult({
    clusters: [cluster],
    lensPlans: [plan],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  });
  const lens = result.lenses[0];
  assert.strictEqual(lens.slug, 'avoid-hardcoding');
  assert(typeof lens.title === 'string');
  assert.strictEqual(lens.count, 3);
  assert.strictEqual(lens.prCount, 3);
  assert.strictEqual(lens.path, '.aidlc/lenses/lens-avoid-hardcoding.md');
});

test('buildJsonResult: lens title falls back to slug when cluster.title is null', () => {
  const cluster = makeCluster({ slug: 'avoid-hardcoding', title: null });
  const result = buildJsonResult({
    clusters: [cluster],
    lensPlans: [makePlan()],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  });
  assert.strictEqual(result.lenses[0].title, 'avoid-hardcoding');
});

test('buildJsonResult: lens title uses cluster.title when provided', () => {
  const cluster = makeCluster({ title: 'Hardcoded Secrets' });
  const result = buildJsonResult({
    clusters: [cluster],
    lensPlans: [makePlan()],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  });
  assert.strictEqual(result.lenses[0].title, 'Hardcoded Secrets');
});

test('buildJsonResult: lens path is null when plan is missing', () => {
  const cluster = makeCluster();
  const result = buildJsonResult({
    clusters: [cluster],
    lensPlans: [undefined],
    totalSignals: 3,
    totalPRs: 3,
    skippedPRs: 0,
  });
  assert.strictEqual(result.lenses[0].path, null);
});

test('buildJsonResult: result is JSON-serializable (no Sets or circular refs)', () => {
  const cluster = makeCluster({ prNumbers: new Set([1, 2]) });
  const result = buildJsonResult({
    clusters: [cluster],
    lensPlans: [makePlan()],
    totalSignals: 2,
    totalPRs: 2,
    skippedPRs: 0,
  });
  // Must not throw
  const serialized = JSON.stringify(result);
  assert(typeof serialized === 'string');
  // And must round-trip cleanly
  const parsed = JSON.parse(serialized);
  assert.strictEqual(parsed.lenses[0].prCount, 2);
});

test('buildJsonResult: multiple lenses in correct order', () => {
  const clusters = [
    makeCluster({ slug: 'first', prNumbers: new Set([1]) }),
    makeCluster({ slug: 'second', prNumbers: new Set([2]) }),
  ];
  const lensPlans = [
    makePlan({ slug: 'first', path: '.aidlc/lenses/lens-first.md' }),
    makePlan({ slug: 'second', path: '.aidlc/lenses/lens-second.md' }),
  ];
  const result = buildJsonResult({
    clusters,
    lensPlans,
    totalSignals: 2,
    totalPRs: 2,
    skippedPRs: 0,
  });
  assert.strictEqual(result.lenses[0].slug, 'first');
  assert.strictEqual(result.lenses[1].slug, 'second');
});
