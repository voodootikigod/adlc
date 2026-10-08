// hollow-test/test/unit.test.mjs
// Unit tests for lib/targets.mjs and lib/report.mjs (pure functions, no I/O).

import { describe, it } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readdirSync } from 'node:fs';
import { tmp } from '@adlc/core/test-kit';

import {
  filterTargetFiles, buildFileTargets,
  readRailsFromTicketFile, expandRailsToFiles,
} from '../lib/targets.mjs';
import { buildJsonReport, printTable } from '../lib/report.mjs';
import { checkSyntax, classifyTestResult, runTest, heapCapMb, withHeapCap, withHeapCapHint, launchFor, GROUP_KILL } from '../lib/runner.mjs';

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
  it('reads rails from a single-ticket-shaped JSON file', (t) => {
    const dir = tmp(t, 'hollow-rails-unit-');
    const p = join(dir, 'ticket.json');
    writeFileSync(p, JSON.stringify({ id: 'T1', rails: ['src/a.mjs', 'src/b.mjs'] }));
    assert.deepEqual(readRailsFromTicketFile(p), ['src/a.mjs', 'src/b.mjs']);
  });

  it('merges rails across all tickets in a full tickets.json-shaped file, deduplicated', (t) => {
    const dir = tmp(t, 'hollow-rails-unit-');
    const p = join(dir, 'tickets.json');
    writeFileSync(p, JSON.stringify({
      tickets: [
        { id: 'T1', rails: ['src/a.mjs'] },
        { id: 'T2', rails: ['src/a.mjs', 'src/c.mjs'] },
      ],
    }));
    assert.deepEqual(readRailsFromTicketFile(p), ['src/a.mjs', 'src/c.mjs']);
  });

  it('returns an empty array when no rails are declared', (t) => {
    const dir = tmp(t, 'hollow-rails-unit-');
    const p = join(dir, 'ticket.json');
    writeFileSync(p, JSON.stringify({ id: 'T1', title: 'no rails here' }));
    assert.deepEqual(readRailsFromTicketFile(p), []);
  });

  it('throws on missing file', () => {
    assert.throws(() => readRailsFromTicketFile('/definitely/not/a/file.json'));
  });

  it('throws on malformed JSON', (t) => {
    const dir = tmp(t, 'hollow-rails-unit-');
    const p = join(dir, 'ticket.json');
    writeFileSync(p, '{ not json');
    assert.throws(() => readRailsFromTicketFile(p));
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
  it('reports valid source as valid', (t) => {
    const dir = tmp(t, 'hollow-checksyntax-');
    const f = join(dir, 'ok.mjs');
    writeFileSync(f, 'export const a = 1;\n');
    assert.equal(checkSyntax(f, dir), 'valid');
  });

  it('reports unparseable source as invalid', (t) => {
    const dir = tmp(t, 'hollow-checksyntax-');
    const f = join(dir, 'bad.mjs');
    writeFileSync(f, 'export function f() {\n  return null;\n    a: 1,\n  };\n}\n');
    assert.equal(checkSyntax(f, dir), 'invalid');
  });

  it('reports UNKNOWN — never valid — when the checker cannot run', (t) => {
    const dir = tmp(t, 'hollow-checksyntax-');
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
      { status: 0, timedOut: false, spawnFailed: false, reason: null, stdout: '', stderr: '' });
    assert.deepEqual(classifyTestResult({ status: 1, signal: null }),
      { status: 1, timedOut: false, spawnFailed: false, reason: null, stdout: '', stderr: '' });
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

  // Unlike EAGAIN/ENOMEM above, this one IS provokable — and it was live: the
  // whole-repo suite emits ~1.5 MB of TAP, spawnSync's default maxBuffer is
  // 1 MiB, and crossing it makes Node SIGTERM the child with ENOBUFS. The
  // mutation gate's full-suite fallback died there every run, reported as a
  // baseline that "is not green (exit null)" — a suite that never finished,
  // wearing the shape of a suite that failed.
  it('a chatty but PASSING suite is green, not a dead baseline', () => {
    // ~4 MiB of stdout, then exit 0. Comfortably over the 1 MiB default.
    const chatty = `node -e "for(let i=0;i<65536;i++)console.log('x'.repeat(63))"`;
    const c = runTest(chatty, 120000, process.cwd());
    assert.equal(c.status, 0, 'a passing suite must report exit 0 however much it printed');
    assert.equal(c.spawnFailed, false, 'output volume is not a launch failure');
    assert.equal(c.timedOut, false);
  });

  it('a chatty FAILING suite still reports its real non-zero exit', () => {
    const chatty = `node -e "for(let i=0;i<65536;i++)console.log('x'.repeat(63));process.exit(1)"`;
    const c = runTest(chatty, 120000, process.cwd());
    assert.equal(c.status, 1, 'a real failure must survive the volume, not become null');
    assert.equal(c.spawnFailed, false);
  });

  it('a missing exit status with no error or signal is undetermined', () => {
    const c = classifyTestResult({ status: null, signal: null });
    assert.equal(c.spawnFailed, true);
    assert.equal(c.timedOut, false);
  });
});

// ── runTest: a timeout ends everything the suite started ────────────────────
//
// spawnSync's timeout only signals its direct child. Before this, that was the
// shell: `node --test` and its workers outlived every timed-out mutant as
// orphans, still running the mutant code; on 2026-10-08 the pile of them froze
// the host. A kill must mean the run is OVER — nothing it started may keep
// running — and it must not cost the operator Ctrl-C to get there.

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// procps is a test-only need (the watchdog reads /proc on Linux); skip, do not crash, without it.
const hasTool = (name) => spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0;
// Report files the runner mints for a given caller pid, left in tmpdir.
const reportsFor = (pid) => readdirSync(tmpdir()).filter((f) => f.startsWith(`hollow-test-watchdog-${pid}-`));

describe('runTest ends everything the suite started on timeout', { skip: !GROUP_KILL }, () => {
  it('a worker the suite spawned does not outlive the timed-out run', async (t) => {
    const dir = tmp(t, 'hollow-pgroup-');
    const pidFile = join(dir, 'worker.pid');
    // The shape of `node --test`: start a long-lived worker, record it, wait on it.
    const r = runTest(`sleep 30 & echo $! > "${pidFile}"; wait`, 3000, dir);
    assert.equal(r.timedOut, true, 'the run must be reported as a timeout');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'the worker recorded its pid');
    for (let i = 0; i < 40 && alive(pid); i++) await settle(50);
    assert.equal(alive(pid), false, `worker ${pid} outlived the timed-out run`);
  });

  it('a run that finishes carries its own exit status and output through the wrapper', () => {
    const r = runTest('echo out; echo err >&2; exit 3', 20000, process.cwd());
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'out\n');
    assert.equal(r.stderr, 'err\n');
    assert.equal(r.timedOut, false);
    assert.equal(r.spawnFailed, false);
  });

  it('a chained command keeps && semantics inside the wrapper', () => {
    const r = runTest('true && exit 2', 20000, process.cwd());
    assert.equal(r.status, 2);
  });

  // The review of the first cut caught this: `detached: true` would have put the
  // suite in its own session, so Ctrl-C no longer reached it and a kill -9 of
  // hollow-test stranded the suite — the orphan class reopened on the interrupt
  // path. The suite must stay in the caller's process group and session.
  it('the suite runs in the caller\'s own process group and session (no setsid)', { skip: !hasTool('ps') && 'needs ps' }, () => {
    const mine = runTest(`ps -o pgid=,sid= -p ${process.pid}`, 20000, process.cwd()).stdout.trim().split(/\s+/);
    const r = runTest('ps -o pgid=,sid= -p $$', 20000, process.cwd());
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\s+/), mine, 'suite pgid/sid must equal the caller\'s');
  });

  // A suite that keeps forking is the case a snapshot-and-kill misses: a child
  // forked after the snapshot, reparented to init once the shell dies. The
  // watchdog freezes the tree before killing it, so none can slip out.
  it('a suite that forks continuously leaves nothing behind either', { skip: !hasTool('pgrep') && 'needs pgrep' }, async (t) => {
    const dir = tmp(t, 'hollow-fork-');
    // A private name for `sleep`, so survivors are found (and killed) by a path
    // no other run on the host can share.
    const link = join(dir, `forked-${process.pid}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(spawnSync('sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).stdout.trim(), link);
    const r = runTest(`while :; do "${link}" 30 & sleep 0.02; done`, 3000, dir);
    assert.equal(r.timedOut, true);
    const survivors = () => {
      const out = spawnSync('pgrep', ['-f', `^${link} 30$`], { encoding: 'utf8' }).stdout.trim();
      return out ? out.split('\n').map(Number) : [];
    };
    let left = survivors();
    for (let i = 0; i < 40 && left.length; i++) { await settle(50); left = survivors(); }
    for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    assert.deepEqual(left, [], `${left.length} forked worker(s) outlived the timed-out run`);
  });

  // A helper the suite double-forked earlier in the trial was reparented to init
  // long before the timeout: not a descendant any more, but it inherited the
  // watchdog's environment marker, and the sweep finds it by that.
  it('a helper double-forked before the timeout (already reparented) is found and killed too', { skip: process.platform !== 'linux' }, async (t) => {
    const dir = tmp(t, 'hollow-reparent-');
    const pidFile = join(dir, 'helper.pid');
    const r = runTest(`(sleep 30 & echo $! > "${pidFile}"); sleep 10`, 3000, dir);
    assert.equal(r.timedOut, true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    for (let i = 0; i < 40 && alive(pid); i++) await settle(50);
    assert.equal(alive(pid), false, `reparented helper ${pid} outlived the timed-out run`);
  });

  // hollow-test is blocked in spawnSync and cannot forward its own death. If it
  // is killed outright (kill -9, its caller's timeout), the watchdog must notice
  // its parent is gone and end the suite itself — otherwise this is the incident
  // class on a different trigger, with nobody left to kill the runaway.
  it('when the caller of runTest is killed outright, the suite dies with it', async (t) => {
    const dir = tmp(t, 'hollow-parent-death-');
    const pidFile = join(dir, 'worker.pid');
    const runnerUrl = new URL('../lib/runner.mjs', import.meta.url).href;
    // A stand-in hollow-test: blocks in runTest for 60 s unless killed.
    const standIn = spawn(process.execPath, ['--input-type=module', '-e',
      `import { runTest } from ${JSON.stringify(runnerUrl)}; runTest(${JSON.stringify(`sleep 30 & echo $! > "${pidFile}"; wait`)}, 60000, ${JSON.stringify(dir)});`,
    ], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await settle(50);
    assert.ok(existsSync(pidFile), 'the suite started');
    const worker = Number(readFileSync(pidFile, 'utf8').trim());
    assert.equal(alive(worker), true);
    standIn.kill('SIGKILL');
    for (let i = 0; i < 80 && alive(worker); i++) await settle(50);
    assert.equal(alive(worker), false, `worker ${worker} outlived the killed caller`);
    for (let i = 0; i < 20 && reportsFor(standIn.pid).length; i++) await settle(50);
    assert.deepEqual(reportsFor(standIn.pid), [], 'no report file is left behind for a caller that cannot read it');
  });

  // The crash path must end what the timeout path ends: a heap-capped node dies
  // by SIGABRT with its workers still running, and the trial is scored a kill.
  it('when the suite crashes on its own, what it left running is swept too', { skip: process.platform !== 'linux' }, async (t) => {
    const dir = tmp(t, 'hollow-crash-');
    const pidFile = join(dir, 'worker.pid');
    const r = runTest(`sleep 30 & echo $! > "${pidFile}"; node -e "setTimeout(() => process.abort(), 200)"`, 20000, dir);
    assert.equal(r.timedOut, false);
    assert.equal(r.status, 134, 'the abort is the trial\'s own exit status');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    for (let i = 0; i < 40 && alive(pid); i++) await settle(50);
    assert.equal(alive(pid), false, `worker ${pid} outlived the crashed suite`);
  });

  // A POSIX shell starts `&` jobs with SIGINT ignored, so Ctrl-C alone would
  // leave `server & npm test`'s server behind. The watchdog sweeps on SIGINT.
  it('Ctrl-C (SIGINT to the foreground group) ends backgrounded helpers as well', async (t) => {
    const dir = tmp(t, 'hollow-sigint-');
    const pidFile = join(dir, 'worker.pid');
    const runnerUrl = new URL('../lib/runner.mjs', import.meta.url).href;
    // A stand-in hollow-test in its own group, so SIGINT can be sent to that group alone.
    const standIn = spawn(process.execPath, ['--input-type=module', '-e',
      `import { runTest } from ${JSON.stringify(runnerUrl)}; runTest(${JSON.stringify(`sleep 30 & echo $! > "${pidFile}"; wait`)}, 60000, ${JSON.stringify(dir)});`,
    ], { stdio: 'ignore', detached: true });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await settle(50);
    assert.ok(existsSync(pidFile), 'the suite started');
    const worker = Number(readFileSync(pidFile, 'utf8').trim());
    process.kill(-standIn.pid, 'SIGINT');
    for (let i = 0; i < 80 && alive(worker); i++) await settle(50);
    try { process.kill(-standIn.pid, 'SIGKILL'); } catch {}
    assert.equal(alive(worker), false, `backgrounded worker ${worker} survived Ctrl-C`);
    for (let i = 0; i < 20 && reportsFor(standIn.pid).length; i++) await settle(50);
    assert.deepEqual(reportsFor(standIn.pid), [], 'no report file is left behind for a caller taken by the same Ctrl-C');
  });

  // This repo gates its own suite: a hollow-test inside a hollow-test. The inner
  // watchdog must extend the marker chain, not replace it, or a helper the inner
  // trial detached is invisible to the OUTER sweep when the outer trial times out.
  it('nested: a helper detached by an inner trial is still found by the outer sweep', { skip: process.platform !== 'linux' }, async (t) => {
    const dir = tmp(t, 'hollow-nested-');
    const pidFile = join(dir, 'helper.pid');
    const inner = `(sleep 30 & echo $! > "${pidFile}"); sleep 10`;
    // The inner watchdog, launched exactly as the runner launches one, as a shell
    // string for the outer trial. Single quotes: the OUTER shell must hand `$!`
    // and the source to the inner one untouched.
    const sq = (a) => `'${a.replace(/'/g, "'\\''")}'`;
    const [cmd, args] = launchFor(inner);
    const r = runTest([cmd, ...args].map(sq).join(' '), 5000, dir);
    assert.equal(r.timedOut, true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    for (let i = 0; i < 40 && alive(pid); i++) await settle(50);
    assert.equal(alive(pid), false, `helper ${pid} detached one level down outlived the outer timeout`);
  });

  it('the sweep says what it ended beyond the shell', async (t) => {
    const dir = tmp(t, 'hollow-said-');
    const r = runTest('sleep 30 & wait', 3000, dir);
    assert.equal(r.timedOut, true);
    assert.match(r.stderr, /watchdog: ended 1 process\(es\) the suite left running: \d+/);
    const quiet = runTest('true', 20000, dir);
    assert.equal(quiet.stderr, '', 'nothing to say when nothing was left running');
  });

  // Run by hand (no report file named), the watchdog says it on its stderr —
  // and on fd 2, not some other descriptor.
  it('without a report file, the watchdog reports on its own stderr', () => {
    const [cmd, args] = launchFor('sleep 30 & exit 0');
    const env = { ...process.env };
    delete env.HOLLOW_TEST_WATCHDOG_REPORT;
    const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /watchdog: ended 1 process\(es\) the suite left running: \d+/);
    assert.equal(r.stdout, '', 'nothing of it on stdout');
  });

  it('a trial is launched through the watchdog SOURCE loaded with the runner, not a path re-read per trial', () => {
    const [command, args] = launchFor('true');
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(0, 2), ['--input-type=module', '-e']);
    assert.match(args[2], /HOLLOW_TEST_WATCHDOG/, 'the watchdog source itself is the argument');
    assert.ok(!args.some((a) => /watchdog\.mjs$/.test(a)), 'no on-disk path: a mutant written there mid-run must not become the harness');
    assert.deepEqual(args.slice(-2), ['--', 'true']);
  });
});

// ── runTest: every run has a heap cap ───────────────────────────────────────

describe('runTest caps the heap of every node it starts', () => {
  const heapLimit = `node -e "console.log(require('v8').getHeapStatistics().heap_size_limit)"`;
  const withEnv = (value, fn) => {
    const had = Object.hasOwn(process.env, 'HOLLOW_TEST_MAX_OLD_SPACE_MB');
    const prev = process.env.HOLLOW_TEST_MAX_OLD_SPACE_MB;
    if (value === undefined) delete process.env.HOLLOW_TEST_MAX_OLD_SPACE_MB; else process.env.HOLLOW_TEST_MAX_OLD_SPACE_MB = value;
    try { return fn(); } finally {
      if (had) process.env.HOLLOW_TEST_MAX_OLD_SPACE_MB = prev; else delete process.env.HOLLOW_TEST_MAX_OLD_SPACE_MB;
    }
  };

  it('HOLLOW_TEST_MAX_OLD_SPACE_MB bounds the child heap (inherited via NODE_OPTIONS)', () => {
    const r = withEnv('256', () => runTest(heapLimit, 20000, process.cwd()));
    assert.equal(r.status, 0, r.stderr);
    const limit = Number(r.stdout.trim());
    // V8 reports old space plus young generation and overhead: 256 MiB lands near 450 MiB.
    assert.ok(limit > 0 && limit < 600 * 1024 * 1024, `heap limit ${limit} is not capped near 256 MiB`);
  });

  it('HOLLOW_TEST_MAX_OLD_SPACE_MB=0 runs uncapped', () => {
    const r = withEnv('0', () => runTest(heapLimit, 20000, process.cwd()));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(Number(r.stdout.trim()) > 512 * 1024 * 1024, 'the cap must be off');
  });

  // Literal 2048 on purpose: comparing against the exported constant would pass
  // for ANY value of it, including undefined (a mutant the gate produced).
  it('heapCapMb: 2048 when unset, 0 disables, garbage falls back to 2048', () => {
    assert.equal(heapCapMb({}), 2048);
    assert.equal(heapCapMb({ HOLLOW_TEST_MAX_OLD_SPACE_MB: '' }), 2048);
    assert.equal(heapCapMb({ HOLLOW_TEST_MAX_OLD_SPACE_MB: '0' }), 0);
    assert.equal(heapCapMb({ HOLLOW_TEST_MAX_OLD_SPACE_MB: '512' }), 512);
    assert.equal(heapCapMb({ HOLLOW_TEST_MAX_OLD_SPACE_MB: 'lots' }), 2048);
    assert.equal(heapCapMb({ HOLLOW_TEST_MAX_OLD_SPACE_MB: '-5' }), 2048);
  });

  it('withHeapCap: appends the cap to NODE_OPTIONS, keeps what was there, drops NODE_TEST_CONTEXT', () => {
    assert.equal(withHeapCap({}).NODE_OPTIONS, '--max-old-space-size=2048');
    assert.equal(withHeapCap({ HOLLOW_TEST_MAX_OLD_SPACE_MB: '1' }).NODE_OPTIONS, '--max-old-space-size=1', 'a 1 MiB cap is still a cap');
    assert.equal(withHeapCap({ NODE_OPTIONS: '--no-warnings', HOLLOW_TEST_MAX_OLD_SPACE_MB: '300' }).NODE_OPTIONS, '--no-warnings --max-old-space-size=300');
    const off = withHeapCap({ NODE_OPTIONS: '--no-warnings', HOLLOW_TEST_MAX_OLD_SPACE_MB: '0', NODE_TEST_CONTEXT: 'child-v8' });
    assert.equal(off.NODE_OPTIONS, '--no-warnings', '0 leaves NODE_OPTIONS untouched');
    assert.equal('NODE_TEST_CONTEXT' in off, false);
    const env = { KEEP: 'me' };
    withHeapCap(env);
    assert.deepEqual(env, { KEEP: 'me' }, 'the input env is not mutated');
  });

  // hollow-test's own suite runs under an outer hollow-test (the repo's mutation
  // gate), which injects its 2048 into NODE_OPTIONS. An explicit variable must
  // win over that, or the test above cannot pass inside the gate — and the
  // package that adds the cap is the package that can no longer gate itself.
  it('a node that dies at a cap THIS runner set gets the knob named in its stderr', () => {
    const oom = 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n';
    const byDefault = withHeapCapHint({ status: 134, stderr: oom }, { mb: 2048, explicit: false });
    assert.match(byDefault.stderr, /--max-old-space-size=2048, hollow-test's default/);
    assert.match(byDefault.stderr, /Set HOLLOW_TEST_MAX_OLD_SPACE_MB higher, or 0/);
    const explicit = withHeapCapHint({ status: 134, stderr: oom }, { mb: 256, explicit: true });
    assert.match(explicit.stderr, /--max-old-space-size=256, from HOLLOW_TEST_MAX_OLD_SPACE_MB/);
    assert.equal(withHeapCapHint({ status: 1, stderr: 'ordinary failure\n' }, { mb: 2048, explicit: false }).stderr, 'ordinary failure\n', 'no hint without a heap OOM');
    assert.equal(withHeapCapHint({ status: 134, stderr: oom }, null).stderr, oom, "an operator's own flag is not blamed on the variable");
    // End to end: a tiny cap, a loop that fills the heap, the hint in the real stderr.
    const r = withEnv('24', () => runTest(`node -e "const a = []; for (;;) a.push(new Array(1e5).fill(1))"`, 60000, process.cwd()));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--max-old-space-size=24, from HOLLOW_TEST_MAX_OLD_SPACE_MB/, r.stderr.slice(-400));
    // An operator's own flag, variable unset: the OOM is theirs, no hint.
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=24';
    try {
      const theirs = withEnv(undefined, () => runTest(`node -e "const a = []; for (;;) a.push(new Array(1e5).fill(1))"`, 60000, process.cwd()));
      assert.notEqual(theirs.status, 0);
      assert.doesNotMatch(theirs.stderr, /HOLLOW_TEST_MAX_OLD_SPACE_MB/);
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
    }
  });

  it('withHeapCap: an explicit HOLLOW_TEST_MAX_OLD_SPACE_MB replaces an inherited flag, in either spelling', () => {
    for (const inherited of ['--max-old-space-size=2048', '--max_old_space_size=2048', '--max-old-space-size 2048']) {
      const o = withHeapCap({ NODE_OPTIONS: `--no-warnings ${inherited} --stack-size=900`, HOLLOW_TEST_MAX_OLD_SPACE_MB: '256' });
      assert.equal(o.NODE_OPTIONS, '--no-warnings --stack-size=900 --max-old-space-size=256', inherited);
    }
    const zero = withHeapCap({ NODE_OPTIONS: '--max-old-space-size=2048', HOLLOW_TEST_MAX_OLD_SPACE_MB: '0' });
    assert.equal(zero.NODE_OPTIONS, '--max-old-space-size=2048', 'explicit 0 leaves NODE_OPTIONS exactly as found');
    const malformed = withHeapCap({ NODE_OPTIONS: '--max-old-space-size=8192', HOLLOW_TEST_MAX_OLD_SPACE_MB: 'lots' });
    assert.equal(malformed.NODE_OPTIONS, '--max-old-space-size=8192', 'a malformed value does not outrank the operator\'s own flag');
  });

  it('withHeapCap: an operator\'s own --max-old-space-size in NODE_OPTIONS wins over the default', () => {
    // V8 accepts `_` for `-` in flag names; both spellings are the operator's choice.
    for (const theirs of ['--max-old-space-size=8192', '--no-warnings --max-old-space-size=8192', '--max-old-space-size 8192', '--max_old_space_size=8192']) {
      assert.equal(withHeapCap({ NODE_OPTIONS: theirs }).NODE_OPTIONS, theirs, theirs);
    }
    const r = runTest(`node -e "console.log(require('v8').getHeapStatistics().heap_size_limit)"`, 20000, process.cwd());
    assert.equal(r.status, 0, r.stderr);
    const capped = Number(r.stdout.trim());
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=3000';
    try {
      const r2 = runTest(`node -e "console.log(require('v8').getHeapStatistics().heap_size_limit)"`, 20000, process.cwd());
      assert.equal(r2.status, 0, r2.stderr);
      assert.ok(Number(r2.stdout.trim()) > capped, 'the operator\'s larger heap must survive into the child');
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prev;
    }
  });
});
