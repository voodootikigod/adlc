// test/could-not-analyze.test.mjs — issue #622: an empty log is "could not
// analyze" (exit 1, never recorded), not CLEAN (exit 0, recorded as P4
// evidence). Covers the exported decision function directly and the CLI end to
// end, including the --record path against an isolated .adlc dir.
//
// Scope is NOT part of that decision: a supervisor passes the ticket's --scope
// on every consult, and a well-behaved session may contain no writes at all —
// so "lines but no extractable path" must stay a normal analyzed log. Those
// cases are pinned here as regressions.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { readEntries, ADLC_DIR } from '../../core/index.mjs';
import { assessAnalyzability, REASON_NO_LINES } from '../lib/analyzability.mjs';
import { parseLog } from '../lib/parse-log.mjs';

const BIN = fileURLToPath(new URL('../bin/flail-detector.mjs', import.meta.url));

function runBin(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

function manifestEntryCount(dir) {
  const adlcDir = join(dir, ADLC_DIR);
  return existsSync(join(adlcDir, 'manifest.jsonl'))
    ? readEntries('manifest', adlcDir).entries.length
    : 0;
}

// ---------------------------------------------------------------------------
// AC6 — the decision function, tested directly
// ---------------------------------------------------------------------------

describe('assessAnalyzability (AC6)', () => {
  test('zero lines is not analyzable', () => {
    const r = assessAnalyzability({ lines: [] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, [REASON_NO_LINES]);
    assert.match(r.reasons[0], /no non-empty lines/);
  });

  test('whitespace-only lines are not analyzable', () => {
    const r = assessAnalyzability({ lines: ['', '   ', '\t'] });
    assert.equal(r.ok, false);
    assert.deepEqual(r.reasons, [REASON_NO_LINES]);
  });

  test('a single non-whitespace character is a non-empty line', () => {
    assert.deepEqual(assessAnalyzability({ lines: ['x'] }), { ok: true, reasons: [] });
    assert.deepEqual(assessAnalyzability({ lines: [' x '] }), { ok: true, reasons: [] });
  });

  test('non-empty lines are analyzable even with no file path in them', () => {
    const r = assessAnalyzability({ lines: ['Build started', 'Done.'] });
    assert.deepEqual(r, { ok: true, reasons: [] });
  });

  test('non-string entries do not count as lines', () => {
    assert.equal(assessAnalyzability({ lines: [null, 42, undefined] }).ok, false);
    assert.equal(assessAnalyzability({ lines: [null, 'x'] }).ok, true);
  });

  test('does not mutate its inputs', () => {
    const lines = ['Writing src/a.mjs', ''];
    assessAnalyzability({ lines });
    assert.deepEqual(lines, ['Writing src/a.mjs', '']);
  });

  test('a JSONL log whose objects carry no text/file targets parses to zero lines', () => {
    const { lines } = parseLog('{"a":1}\n{"b":2}\n');
    assert.deepEqual(lines, []);
    assert.equal(assessAnalyzability({ lines }).ok, false);
  });
});

// ---------------------------------------------------------------------------
// CLI — AC1..AC5
// ---------------------------------------------------------------------------

describe('CLI: could-not-analyze outcome', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'flail-detector-cna-'));
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('AC1: empty log exits 1 with "could not analyze" on stderr, nothing on stdout', () => {
    const f = join(dir, 'empty.log');
    writeFileSync(f, '');
    const r = runBin([f], dir);
    assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stderr, /flail-detector: could not analyze — /);
    assert.match(r.stderr, /no non-empty lines/);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /CLEAN/);
  });

  test('AC1b: empty log with --scope is still could-not-analyze (exit 1), with the one reason', () => {
    const f = join(dir, 'empty-scoped.log');
    writeFileSync(f, '');
    const r = runBin([f, '--scope', 'src/**', '--json'], dir);
    assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, 'could-not-analyze');
    assert.deepEqual(parsed.reasons, [REASON_NO_LINES]);
  });

  test('AC2: whitespace-only log with --json prints one could-not-analyze document, exits 1', () => {
    const f = join(dir, 'ws.log');
    const content = '  \n\t\n\n';
    writeFileSync(f, content);
    const r = runBin([f, '--json'], dir);
    assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout); // the whole stdout is exactly one document
    assert.equal(parsed.verdict, 'could-not-analyze');
    assert.ok(Array.isArray(parsed.reasons) && parsed.reasons.length > 0, 'reasons must be non-empty');
    assert.deepEqual(parsed.signals, []);
    assert.equal(parsed.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(r.stderr, '');
  });

  test('AC3 (regression pin): --scope on a clean log with no file path is CLEAN exit 0 — a well-behaved session may write nothing', () => {
    const f = join(dir, 'all-good.log');
    writeFileSync(f, 'all good\nbuild succeeded\n');

    const scoped = runBin([f, '--scope', 'src/**'], dir);
    assert.equal(scoped.status, 0, `stdout: ${scoped.stdout} stderr: ${scoped.stderr}`);
    assert.match(scoped.stdout, /flail-detector: CLEAN/);
    assert.equal(scoped.stderr, '');

    const scopedJson = runBin([f, '--scope', 'src/**', '--json'], dir);
    assert.equal(scopedJson.status, 0);
    assert.equal(JSON.parse(scopedJson.stdout).verdict, 'clean');

    const unscoped = runBin([f], dir);
    assert.equal(unscoped.status, 0, unscoped.stderr);
  });

  test('AC3b (regression pin): --scope never pre-empts a real repeated-error flail (exit 2, not 1)', () => {
    const f = join(dir, 'boom.log');
    writeFileSync(f, 'error: boom\nerror: boom\n');
    const r = runBin([f, '--scope', 'src/**', '--json'], dir);
    assert.equal(r.status, 2, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.verdict, 'flail');
    assert.ok(parsed.signals.some((s) => s.type === 'repeated-error'));
  });

  test('AC3c: --scope on a log WITH a file path still analyzes scope (in-scope clean, out-of-scope flail)', () => {
    const f = join(dir, 'paths.log');
    writeFileSync(f, 'Writing src/a.mjs\nDone.\n');
    const clean = runBin([f, '--scope', 'src/**'], dir);
    assert.equal(clean.status, 0, clean.stderr);
    const flail = runBin([f, '--scope', 'lib/**'], dir);
    assert.equal(flail.status, 2, flail.stderr);
  });

  test('AC4: --record --ticket T1 on an empty log appends nothing to the manifest', () => {
    const f = join(dir, 'empty-record.log');
    writeFileSync(f, '');
    const beforeCount = manifestEntryCount(dir);

    const r = runBin([f, '--record', '--ticket', 'T1'], dir);
    assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.equal(manifestEntryCount(dir), beforeCount, 'could-not-analyze must never mint P4 evidence');

    const rj = runBin([f, '--record', '--ticket', 'T1', '--json'], dir);
    assert.equal(rj.status, 1);
    assert.equal(manifestEntryCount(dir), beforeCount);
  });

  test('AC4b (regression pin): --record on a scoped clean session with no writes still records', () => {
    const f = join(dir, 'scoped-record.log');
    writeFileSync(f, 'all good\nbuild succeeded\n');
    const beforeCount = manifestEntryCount(dir);
    const r = runBin([f, '--scope', 'src/**', '--record', '--ticket', 'T1'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(manifestEntryCount(dir), beforeCount + 1);
  });

  test('AC5 (regression): non-empty clean log is CLEAN exit 0 and --record still appends a flail-check entry', () => {
    const f = join(dir, 'clean.log');
    writeFileSync(f, 'Build started\nDone in 2.3s\nAll tests passed.\n');
    const beforeCount = manifestEntryCount(dir);

    const r = runBin([f, '--record', '--ticket', 'T1'], dir);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stdout, /flail-detector: CLEAN/);
    assert.equal(manifestEntryCount(dir), beforeCount + 1, 'a genuinely analyzed clean log still records');

    const { entries } = readEntries('manifest', join(dir, ADLC_DIR));
    const entry = entries[entries.length - 1];
    assert.equal(entry.type, 'flail-check');
    assert.equal(entry.verdict, 'clean');
    assert.equal(entry.ticket, 'T1');
  });

  test('AC5b (regression): a real flail is still exit 2, never could-not-analyze', () => {
    const f = join(dir, 'flail.log');
    writeFileSync(f, 'Error: cannot connect\nError: cannot connect\n');
    const r = runBin([f, '--json'], dir);
    assert.equal(r.status, 2);
    assert.equal(JSON.parse(r.stdout).verdict, 'flail');
  });

  test('--help documents could-not-analyze as an exit-1 operational outcome', () => {
    const r = runBin(['--help'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verdict: 'flail' \| 'clean' \| 'could-not-analyze'/);
    // the exit-code table must file could-not-analyze under 1, matching the CLI
    assert.match(r.stdout, /^\s+1\s+operational error \(.*could-not-analyze\)$/m);
    assert.doesNotMatch(r.stdout, /^\s+[02]\s+.*could-not-analyze/m);
  });
});
