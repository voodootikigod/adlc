// hollow-test/test/unit.test.mjs
// Unit tests for lib/targets.mjs and lib/report.mjs (pure functions, no I/O).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  filterTargetFiles, buildFileTargets,
  readRailsFromTicketFile, expandRailsToFiles,
} from '../lib/targets.mjs';
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

  // ── priorityFiles reservation (review round 1: budget starvation) ────────

  it('guarantees a priority file at least 1 quota even when the budget equals the diff-file count', () => {
    const changedLines = {
      'a.mjs': new Set([1]),
      'b.mjs': new Set([2]),
      'c.mjs': new Set([3]),
      'explicit.mjs': new Set(),
    };
    const files = ['a.mjs', 'b.mjs', 'c.mjs', 'explicit.mjs'];
    // Old round-robin-by-index math gives explicit.mjs (last index) quota 0
    // when maxTotal === diffFiles.length. The priority reservation must
    // prevent that.
    const targets = buildFileTargets(files, changedLines, 3, '/tmp', ['explicit.mjs']);
    const explicitTarget = targets.find((t) => t.file === 'explicit.mjs');
    assert.ok(explicitTarget.quota >= 1,
      `Expected explicit.mjs to receive at least 1 quota, got ${explicitTarget.quota}`);
    const totalQuota = targets.reduce((s, t) => s + t.quota, 0);
    assert.equal(totalQuota, 3, 'total quota must still equal maxTotal');
  });

  it('reserves 1 quota per priority file before distributing the remainder', () => {
    const changedLines = {
      'a.mjs': new Set([1]),
      'explicit1.mjs': new Set(),
      'explicit2.mjs': new Set(),
    };
    const files = ['a.mjs', 'explicit1.mjs', 'explicit2.mjs'];
    const targets = buildFileTargets(files, changedLines, 2, '/tmp', ['explicit1.mjs', 'explicit2.mjs']);
    const byFile = Object.fromEntries(targets.map((t) => [t.file, t.quota]));
    assert.equal(byFile['explicit1.mjs'], 1);
    assert.equal(byFile['explicit2.mjs'], 1);
    assert.equal(byFile['a.mjs'], 0);
    const totalQuota = targets.reduce((s, t) => s + t.quota, 0);
    assert.equal(totalQuota, 2);
  });

  it('cannot reserve more than maxTotal when priority files outnumber the budget', () => {
    const changedLines = { 'e1.mjs': new Set(), 'e2.mjs': new Set(), 'e3.mjs': new Set() };
    const files = ['e1.mjs', 'e2.mjs', 'e3.mjs'];
    const targets = buildFileTargets(files, changedLines, 1, '/tmp', files);
    const totalQuota = targets.reduce((s, t) => s + t.quota, 0);
    assert.equal(totalQuota, 1, 'total quota must never exceed maxTotal');
    const zeroQuotaCount = targets.filter((t) => t.quota === 0).length;
    assert.equal(zeroQuotaCount, 2, 'exactly 2 of the 3 priority files can not be covered by a budget of 1');
  });

  it('is backward compatible when priorityFiles is omitted (no reservation)', () => {
    const changedLines = { 'a.mjs': new Set([1]), 'b.mjs': new Set([2]) };
    const files = ['a.mjs', 'b.mjs'];
    const targets = buildFileTargets(files, changedLines, 4, '/tmp');
    assert.equal(targets.find((t) => t.file === 'a.mjs').quota, 2);
    assert.equal(targets.find((t) => t.file === 'b.mjs').quota, 2);
  });
});

// ── readRailsFromTicketFile / expandRailsToFiles (issues #70, #41) ─────────

describe('readRailsFromTicketFile', () => {
  let dir;

  it('reads rails from a single-ticket-shaped JSON file', () => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-rails-unit-'));
    const p = join(dir, 'ticket.json');
    writeFileSync(p, JSON.stringify({ id: 'T1', rails: ['src/a.mjs', 'src/b.mjs'] }));
    assert.deepEqual(readRailsFromTicketFile(p), ['src/a.mjs', 'src/b.mjs']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges rails across all tickets in a full tickets.json-shaped file, deduplicated', () => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-rails-unit-'));
    const p = join(dir, 'tickets.json');
    writeFileSync(p, JSON.stringify({
      tickets: [
        { id: 'T1', rails: ['src/a.mjs'] },
        { id: 'T2', rails: ['src/a.mjs', 'src/c.mjs'] },
      ],
    }));
    assert.deepEqual(readRailsFromTicketFile(p), ['src/a.mjs', 'src/c.mjs']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty array when no rails are declared', () => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-rails-unit-'));
    const p = join(dir, 'ticket.json');
    writeFileSync(p, JSON.stringify({ id: 'T1', title: 'no rails here' }));
    assert.deepEqual(readRailsFromTicketFile(p), []);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws on missing file', () => {
    assert.throws(() => readRailsFromTicketFile('/definitely/not/a/file.json'));
  });

  it('throws on malformed JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-rails-unit-'));
    const p = join(dir, 'ticket.json');
    writeFileSync(p, '{ not json');
    assert.throws(() => readRailsFromTicketFile(p));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('expandRailsToFiles', () => {
  it('matches globs against a candidate file list', () => {
    const allFiles = ['src/foo.mjs', 'src/bar.mjs', 'test/foo.test.mjs', 'README.md'];
    assert.deepEqual(expandRailsToFiles(['src/**'], allFiles), ['src/foo.mjs', 'src/bar.mjs']);
  });

  it('deduplicates when multiple globs match the same file', () => {
    const allFiles = ['src/foo.mjs'];
    assert.deepEqual(expandRailsToFiles(['src/*.mjs', 'src/foo.mjs'], allFiles), ['src/foo.mjs']);
  });

  it('returns empty array for empty rails', () => {
    assert.deepEqual(expandRailsToFiles([], ['src/foo.mjs']), []);
  });

  it('returns empty array when no files match', () => {
    assert.deepEqual(expandRailsToFiles(['nomatch/**'], ['src/foo.mjs']), []);
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
