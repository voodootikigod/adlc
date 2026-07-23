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
import { buildJsonReport, printTable } from '../lib/report.mjs';
import { checkSyntax, classifyTestResult } from '../lib/runner.mjs';

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

// ── invalid mutants in the report surfaces (#293) ────────────────────────────
//
// An unparseable mutant belongs to NEITHER bucket. Counting it killed fakes
// coverage; counting it survived blames the tests for code that was never
// valid. Both report surfaces have to agree on that, and the human-readable
// table is the one a person actually reads when a gate fails.

const MIXED = [
  { file: 'a.mjs', line: 1, operator: 'null-return', killed: false, invalid: true,  timedOut: false, original: 'return {', mutated: 'return null;' },
  { file: 'a.mjs', line: 2, operator: 'off-by-one',  killed: true,  invalid: false, timedOut: false, original: 'a: 1,',    mutated: 'a: 2,' },
  { file: 'a.mjs', line: 3, operator: 'bool-flip',   killed: false, invalid: false, timedOut: false, original: 'x = true', mutated: 'x = false' },
];

describe('buildJsonReport with invalid mutants', () => {
  it('counts invalid separately from killed and survived', () => {
    const r = buildJsonReport(MIXED);
    assert.deepEqual(r.summary, { total: 3, killed: 1, survived: 1, invalid: 1, undetermined: 0 });
  });

  it('labels each mutant with its own status', () => {
    const r = buildJsonReport(MIXED);
    assert.deepEqual(r.mutants.map((m) => m.status), ['invalid', 'killed', 'survived']);
  });

  it('never lets an invalid mutant inflate the killed count', () => {
    const allInvalid = MIXED.map((m) => ({ ...m, killed: true, invalid: true }));
    const r = buildJsonReport(allInvalid);
    assert.equal(r.summary.killed, 0, 'invalid wins over a stale killed flag');
    assert.equal(r.summary.invalid, 3);
  });
});

describe('printTable with invalid mutants', () => {
  function capture(results) {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try { printTable(results); } finally { console.log = original; }
    return lines.join('\n');
  }

  it('shows INVALID rather than SURVIVED, and explains why', () => {
    const out = capture(MIXED);
    assert.match(out, /INVALID\s+a\.mjs:1/);
    assert.match(out, /did not parse/);
    // The invalid row must not be presented as a survivor — that would read as
    // "your tests failed to catch this" for code that never compiled.
    assert.doesNotMatch(out, /SURVIVED\s+a\.mjs:1/);
  });

  it('totals exclude invalid from both buckets and report it separately', () => {
    const out = capture(MIXED);
    assert.match(out, /Total: 3\s+Killed: 1\s+Survived: 1\s+Invalid: 1/);
  });

  it('omits the Invalid column entirely when there are none', () => {
    const out = capture(MIXED.filter((m) => !m.invalid));
    assert.match(out, /Total: 2\s+Killed: 1\s+Survived: 1/);
    assert.doesNotMatch(out, /Invalid:/);
  });

  it('prints the diff for survivors and invalids, since both need inspecting', () => {
    const out = capture(MIXED);
    assert.match(out, /original: return \{/);   // invalid
    assert.match(out, /original: x = true/);     // survivor
  });
});

// ── checkSyntax is TRI-STATE (#293) ──────────────────────────────────────────
//
// "Could not determine" is not the same as "valid". Treating a spawn failure or
// timeout as valid reopens the exact false-kill path this work closes: the test
// command then runs against unparseable source, exits non-zero on the parse
// error, and that is scored as a kill. Transient process exhaustion would be
// silently converted into coverage evidence.

describe('checkSyntax', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hollow-checksyntax-'));

  it('reports valid source as valid', () => {
    const f = join(dir, 'ok.mjs');
    writeFileSync(f, 'export const a = 1;\n');
    assert.equal(checkSyntax(f, dir), 'valid');
  });

  it('reports unparseable source as invalid', () => {
    const f = join(dir, 'bad.mjs');
    writeFileSync(f, 'export function f() {\n  return null;\n    a: 1,\n  };\n}\n');
    assert.equal(checkSyntax(f, dir), 'invalid');
  });

  it('reports UNKNOWN — never valid — when the checker cannot run', () => {
    const f = join(dir, 'ok2.mjs');
    writeFileSync(f, 'export const a = 1;\n');
    assert.equal(
      checkSyntax(f, dir, join(dir, 'no-such-node-binary')),
      'unknown',
      'a checker that cannot run proves nothing about the file'
    );
  });
});

// A checker failure is NOT a survivor. Mapping it to `survived` asserts a test
// outcome for a test that never ran, and points remediation at the test suite
// when the real problem is the execution environment.
describe('report surfaces distinguish a checker failure from a survivor', () => {
  const WITH_CHECK_FAILURE = [
    { file: 'a.mjs', line: 1, operator: 'null-return', killed: false, invalid: false, undetermined: true,  timedOut: false, original: 'return {', mutated: 'return null;' },
    { file: 'a.mjs', line: 2, operator: 'bool-flip',   killed: false, invalid: false, undetermined: false, timedOut: false, original: 'x = true', mutated: 'x = false' },
  ];

  it('JSON gives it its own status and keeps it out of survived', () => {
    const r = buildJsonReport(WITH_CHECK_FAILURE);
    assert.equal(r.summary.survived, 1, 'only the genuine survivor counts');
    assert.equal(r.summary.undetermined, 1);
    assert.deepEqual(r.mutants.map((m) => m.status), ['undetermined', 'survived']);
  });

  it('carries the reason, so a checker failure is distinguishable from a launch failure', () => {
    const withReason = [{ ...WITH_CHECK_FAILURE[0], reason: 'test command did not run (EAGAIN)' }];
    const r = buildJsonReport(withReason);
    assert.equal(r.mutants[0].reason, 'test command did not run (EAGAIN)');
  });

  it('the table does not label it SURVIVED', () => {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try { printTable(WITH_CHECK_FAILURE); } finally { console.log = original; }
    const out = lines.join('\n');
    assert.doesNotMatch(out, /SURVIVED\s+a\.mjs:1/);
    assert.match(out, /UNDETERMINED\s+a\.mjs:1/);
  });
});

// ── classifyTestResult: a kill must mean the tests RAN and failed ────────────
//
// This previously read `timedOut = signal === 'SIGTERM' || status === null`,
// folding spawn failures into "timed out" — and a timeout counts as a kill. So
// a transient inability to LAUNCH the test command became coverage evidence:
// the same false-kill shape as an unparseable mutant (#293), one layer down.
//
// EAGAIN/ENOMEM under process pressure cannot be provoked reliably in a test,
// which is precisely how this stayed unnoticed. Hence synthetic results.

describe('classifyTestResult', () => {
  it('a completed run carries its exit status and is neither timeout nor spawn failure', () => {
    assert.deepEqual(classifyTestResult({ status: 0, signal: null }),
      { status: 0, timedOut: false, spawnFailed: false, reason: null });
    assert.deepEqual(classifyTestResult({ status: 1, signal: null }),
      { status: 1, timedOut: false, spawnFailed: false, reason: null });
  });

  it('a real timeout is a timeout, in both shapes Node reports it', () => {
    // SIGTERM from the `timeout` option...
    assert.equal(classifyTestResult({ status: null, signal: 'SIGTERM' }).timedOut, true);
    // ...and ETIMEDOUT, which other Node versions surface instead.
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    assert.equal(classifyTestResult({ status: null, signal: null, error: err }).timedOut, true);
  });

  it('a spawn failure is NOT a timeout and NOT a kill', () => {
    for (const code of ['EAGAIN', 'ENOMEM', 'ENOENT']) {
      const error = Object.assign(new Error(code), { code });
      const c = classifyTestResult({ status: null, signal: null, error });
      assert.equal(c.spawnFailed, true, `${code} must be a spawn failure`);
      assert.equal(c.timedOut, false, `${code} must not masquerade as a timeout`);
      assert.equal(c.reason, code);
    }
  });

  it('an unexpected signal is undetermined, not a timeout', () => {
    const c = classifyTestResult({ status: null, signal: 'SIGKILL' });
    assert.equal(c.spawnFailed, true);
    assert.equal(c.timedOut, false);
    assert.match(c.reason, /SIGKILL/);
  });

  // `error` only reports whether the SHELL launched. If /bin/sh starts but
  // cannot exec the inner test binary it exits 126/127 with a numeric status —
  // which would otherwise read as a completed run and be credited as a kill.
  // The green baseline already proved this command can launch, so a 126/127
  // during a mutant trial is a launch regression, not a verdict.
  it('shell-level launch failures (126/127) are undetermined, not kills', () => {
    for (const status of [126, 127]) {
      const c = classifyTestResult({ status, signal: null });
      assert.equal(c.spawnFailed, true, `exit ${status} must not be a verdict`);
      assert.match(c.reason, /could not launch/);
    }
    // ...but ordinary non-zero exits remain real test failures.
    for (const status of [1, 2, 125, 128]) {
      assert.equal(classifyTestResult({ status, signal: null }).spawnFailed, false,
        `exit ${status} is a genuine test failure`);
    }
  });

  it('a missing exit status with no error or signal is undetermined', () => {
    const c = classifyTestResult({ status: null, signal: null });
    assert.equal(c.spawnFailed, true);
    assert.equal(c.timedOut, false);
  });
});
