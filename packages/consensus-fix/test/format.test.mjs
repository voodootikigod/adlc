/**
 * Tests for format.mjs — human-readable and JSON output.
 * Pure: no I/O, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, formatJson } from '../lib/format.mjs';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeGroups(candidates) {
  // Build a Map keyed by changeset key (simplified: by content of first change).
  const map = new Map();
  for (const c of candidates) {
    const key = JSON.stringify(c.changes);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  return map;
}

function makeCandidate(index, content, changedLines = 1) {
  return {
    index,
    changes: [{ file: 'src/a.mjs', content }],
    changedLines,
    passed: true,
  };
}

// ─── formatReport ─────────────────────────────────────────────────────────────

test('formatReport includes summary counts', () => {
  const survivors = [makeCandidate(0, 'fix')];
  const failed = [makeCandidate(1, 'bad')];
  const discarded = [];
  const groups = makeGroups(survivors);
  const selectionResult = { winner: survivors[0], largestGroupSize: 1 };

  const out = formatReport({
    survivors,
    discarded,
    failed,
    groups,
    allDivergent: false,
    selectionResult,
    applied: false,
    dryRun: true,
  });

  assert.ok(out.includes('2'), 'total should be 2 (1 passed + 1 failed)');
  assert.ok(out.includes('Passed'), 'should mention passed');
  assert.ok(out.includes('Failed') || out.includes('failed'), 'should mention failed');
});

test('formatReport shows "No survivors" when survivors is empty', () => {
  const out = formatReport({
    survivors: [],
    discarded: [],
    failed: [makeCandidate(0, 'bad')],
    groups: new Map(),
    allDivergent: false,
    selectionResult: null,
    applied: false,
    dryRun: true,
  });

  assert.ok(out.includes('No survivors') || out.includes('no survivors'));
});

test('formatReport lists discarded candidate reason', () => {
  const discarded = [{ index: 0, reason: 'file not in provided list' }];
  const out = formatReport({
    survivors: [],
    discarded,
    failed: [],
    groups: new Map(),
    allDivergent: false,
    selectionResult: null,
    applied: false,
    dryRun: true,
  });

  assert.ok(out.includes('file not in provided list'));
});

test('formatReport shows ALL-DIVERGENT warning when allDivergent=true', () => {
  const c1 = makeCandidate(0, 'fix1');
  const c2 = makeCandidate(1, 'fix2');
  const c3 = makeCandidate(2, 'fix3');
  const survivors = [c1, c2, c3];
  const groups = makeGroups(survivors);
  const selectionResult = { winner: c1, largestGroupSize: 1 };

  const out = formatReport({
    survivors,
    discarded: [],
    failed: [],
    groups,
    allDivergent: true,
    selectionResult,
    applied: false,
    dryRun: true,
  });

  assert.ok(
    out.toLowerCase().includes('divergent') || out.includes('DIVERGENT'),
    'should mention divergent'
  );
  assert.ok(
    out.toLowerCase().includes('escalate'),
    'should mention escalate'
  );
});

test('formatReport shows winner candidate index', () => {
  const winner = makeCandidate(2, 'best fix', 3);
  const survivors = [makeCandidate(0, 'other'), winner];
  const groups = makeGroups(survivors);
  const selectionResult = { winner, largestGroupSize: 1 };

  const out = formatReport({
    survivors,
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult,
    applied: false,
    dryRun: true,
  });

  // Winner is candidate [3] (index 2, displayed as index+1)
  assert.ok(out.includes('3') || out.includes('Winner'));
  assert.ok(out.includes('src/a.mjs'), 'should list changed file');
});

test('formatReport dry-run shows apply instruction', () => {
  const winner = makeCandidate(0, 'fix');
  const groups = makeGroups([winner]);
  const selectionResult = { winner, largestGroupSize: 1 };

  const out = formatReport({
    survivors: [winner],
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult,
    applied: false,
    dryRun: true,
  });

  assert.ok(out.includes('--apply') || out.includes('Dry-run') || out.includes('dry-run'));
});

test('formatReport applied=true shows fix was applied', () => {
  const winner = makeCandidate(0, 'fix');
  const groups = makeGroups([winner]);
  const selectionResult = { winner, largestGroupSize: 1 };

  const out = formatReport({
    survivors: [winner],
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult,
    applied: true,
    dryRun: false,
  });

  assert.ok(
    out.toLowerCase().includes('applied'),
    'should confirm fix was applied'
  );
});

// ─── formatJson ───────────────────────────────────────────────────────────────

test('formatJson returns an object with summary field', () => {
  const survivors = [makeCandidate(0, 'fix')];
  const groups = makeGroups(survivors);
  const selectionResult = { winner: survivors[0], largestGroupSize: 1 };

  const result = formatJson({
    survivors,
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult,
    applied: false,
  });

  assert.ok(typeof result === 'object' && result !== null);
  assert.ok('summary' in result, 'must have summary field');
});

test('formatJson summary has correct counts', () => {
  const survivors = [makeCandidate(0, 'fix1'), makeCandidate(1, 'fix1')];
  const failed = [makeCandidate(2, 'bad')];
  const discarded = [{ index: 3, reason: 'invalid' }];
  const groups = makeGroups(survivors);
  const selectionResult = { winner: survivors[0], largestGroupSize: 2 };

  const result = formatJson({
    survivors,
    discarded,
    failed,
    groups,
    allDivergent: false,
    selectionResult,
    applied: false,
  });

  assert.equal(result.summary.total, 4); // 2 + 1 + 1
  assert.equal(result.summary.passed, 2);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.discarded, 1);
});

test('formatJson summary.allDivergent reflects input', () => {
  const c = makeCandidate(0, 'fix');
  const groups = makeGroups([c]);

  const trueResult = formatJson({
    survivors: [c],
    discarded: [],
    failed: [],
    groups,
    allDivergent: true,
    selectionResult: { winner: c, largestGroupSize: 1 },
    applied: false,
  });
  assert.equal(trueResult.summary.allDivergent, true);

  const falseResult = formatJson({
    survivors: [c],
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult: { winner: c, largestGroupSize: 1 },
    applied: false,
  });
  assert.equal(falseResult.summary.allDivergent, false);
});

test('formatJson winner is null when selectionResult is null', () => {
  const result = formatJson({
    survivors: [],
    discarded: [],
    failed: [],
    groups: new Map(),
    allDivergent: false,
    selectionResult: null,
    applied: false,
  });

  assert.equal(result.winner, null);
});

test('formatJson winner shape when present', () => {
  const winner = makeCandidate(1, 'best fix', 5);
  const groups = makeGroups([winner]);
  const selectionResult = { winner, largestGroupSize: 1 };

  const result = formatJson({
    survivors: [winner],
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult,
    applied: true,
  });

  assert.ok(result.winner !== null, 'winner should not be null');
  assert.equal(result.winner.index, 1);
  assert.equal(result.winner.changedLines, 5);
  assert.equal(result.winner.largestGroupSize, 1);
  assert.ok(Array.isArray(result.winner.changes), 'changes should be an array');
  assert.equal(result.winner.applied, true);
});

test('formatJson groups field is an array', () => {
  const c1 = makeCandidate(0, 'fix1');
  const c2 = makeCandidate(1, 'fix1');
  const c3 = makeCandidate(2, 'fix2');
  const groups = makeGroups([c1, c2, c3]);
  const selectionResult = { winner: c1, largestGroupSize: 2 };

  const result = formatJson({
    survivors: [c1, c2, c3],
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult,
    applied: false,
  });

  assert.ok(Array.isArray(result.groups), 'groups should be an array');
  assert.equal(result.groups.length, 2);

  const big = result.groups.find((g) => g.size === 2);
  assert.ok(big, 'should have a group of size 2');
  assert.ok(Array.isArray(big.candidateIndices));
  assert.ok(big.candidateIndices.includes(0) && big.candidateIndices.includes(1));
});

test('formatJson discardedDetails lists reason per discarded item', () => {
  const result = formatJson({
    survivors: [],
    discarded: [
      { index: 0, reason: 'invalid JSON' },
      { index: 1, reason: 'file not in provided list' },
    ],
    failed: [],
    groups: new Map(),
    allDivergent: false,
    selectionResult: null,
    applied: false,
  });

  assert.ok(Array.isArray(result.discardedDetails));
  assert.equal(result.discardedDetails.length, 2);
  assert.equal(result.discardedDetails[0].reason, 'invalid JSON');
  assert.equal(result.discardedDetails[1].reason, 'file not in provided list');
});

test('formatJson result is JSON-serializable (no Maps or Sets)', () => {
  const c = makeCandidate(0, 'fix');
  const groups = makeGroups([c]);

  const result = formatJson({
    survivors: [c],
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult: { winner: c, largestGroupSize: 1 },
    applied: false,
  });

  // Should not throw.
  const serialized = JSON.stringify(result);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.summary.passed, 1);
});

test('formatJson summary.groups equals number of distinct groups', () => {
  const c1 = makeCandidate(0, 'alpha');
  const c2 = makeCandidate(1, 'beta');
  const c3 = makeCandidate(2, 'alpha'); // same as c1
  const groups = makeGroups([c1, c2, c3]);

  const result = formatJson({
    survivors: [c1, c2, c3],
    discarded: [],
    failed: [],
    groups,
    allDivergent: false,
    selectionResult: { winner: c1, largestGroupSize: 2 },
    applied: false,
  });

  assert.equal(result.summary.groups, 2);
});
