// hollow-test/test/unit.test.mjs
// Unit tests for lib/targets.mjs and lib/report.mjs (pure functions, no I/O).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filterTargetFiles, buildFileTargets } from '../lib/targets.mjs';
import { buildJsonReport } from '../lib/report.mjs';

// ── filterTargetFiles ────────────────────────────────────────────────────────

describe('filterTargetFiles', () => {
  it('excludes test/ files', () => {
    const changedLines = {
      'src/foo.mjs': new Set([1]),
      'test/foo.test.mjs': new Set([2]),
    };
    const result = filterTargetFiles(changedLines);
    assert.deepEqual(result, ['src/foo.mjs']);
  });

  it('excludes spec/ files', () => {
    const changedLines = {
      'lib/bar.mjs': new Set([1]),
      'spec/bar.spec.mjs': new Set([2]),
    };
    const result = filterTargetFiles(changedLines);
    assert.deepEqual(result, ['lib/bar.mjs']);
  });

  it('excludes .md files', () => {
    const changedLines = {
      'src/baz.mjs': new Set([1]),
      'README.md': new Set([2]),
    };
    const result = filterTargetFiles(changedLines);
    assert.deepEqual(result, ['src/baz.mjs']);
  });

  it('excludes .json files', () => {
    const changedLines = {
      'src/x.mjs': new Set([1]),
      'package.json': new Set([2]),
    };
    const result = filterTargetFiles(changedLines);
    assert.deepEqual(result, ['src/x.mjs']);
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(filterTargetFiles({}), []);
  });
});

// ── buildFileTargets ─────────────────────────────────────────────────────────

describe('buildFileTargets', () => {
  it('distributes quota evenly', () => {
    const changedLines = {
      'a.mjs': new Set([1]),
      'b.mjs': new Set([2]),
      'c.mjs': new Set([3]),
      'd.mjs': new Set([4]),
    };
    const files = Object.keys(changedLines);
    const targets = buildFileTargets(files, changedLines, 20, '/tmp');
    const totalQuota = targets.reduce((s, t) => s + t.quota, 0);
    assert.equal(totalQuota, 20);
  });

  it('handles remainder distribution', () => {
    const changedLines = {
      'a.mjs': new Set([1]),
      'b.mjs': new Set([2]),
      'c.mjs': new Set([3]),
    };
    const files = Object.keys(changedLines);
    const targets = buildFileTargets(files, changedLines, 10, '/tmp');
    const totalQuota = targets.reduce((s, t) => s + t.quota, 0);
    assert.equal(totalQuota, 10);
    // 10 / 3 = 3 remainder 1 → [4, 3, 3]
    const quotas = targets.map((t) => t.quota);
    assert.equal(quotas[0], 4);
    assert.equal(quotas[1], 3);
    assert.equal(quotas[2], 3);
  });

  it('returns empty array for empty files', () => {
    const targets = buildFileTargets([], {}, 20, '/tmp');
    assert.deepEqual(targets, []);
  });
});

// ── buildJsonReport ──────────────────────────────────────────────────────────

describe('buildJsonReport', () => {
  it('counts killed and survived correctly', () => {
    const results = [
      { file: 'a.mjs', line: 1, operator: 'bool-flip', killed: true, timedOut: false, original: 'return true;', mutated: 'return false;' },
      { file: 'a.mjs', line: 2, operator: 'off-by-one', killed: false, timedOut: false, original: 'return n + 1;', mutated: 'return n + 2;' },
    ];
    const report = buildJsonReport(results);
    assert.equal(report.summary.total, 2);
    assert.equal(report.summary.killed, 1);
    assert.equal(report.summary.survived, 1);
    assert.equal(report.mutants[0].status, 'killed');
    assert.equal(report.mutants[1].status, 'survived');
  });

  it('returns empty mutants list for empty results', () => {
    const report = buildJsonReport([]);
    assert.equal(report.summary.total, 0);
    assert.deepEqual(report.mutants, []);
  });

  it('sets timedOut field correctly', () => {
    const results = [
      { file: 'x.mjs', line: 1, operator: 'null-return', killed: true, timedOut: true, original: 'return x;', mutated: 'return null;' },
    ];
    const report = buildJsonReport(results);
    assert.equal(report.mutants[0].timedOut, true);
  });
});
