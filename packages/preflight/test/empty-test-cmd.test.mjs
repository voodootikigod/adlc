// preflight — a PRESENT-but-EMPTY --test-cmd must be rejected, never skipped (#712).
//
// `preflight --test-cmd "$TEST_CMD"` with an unset variable used to drop the
// check silently and print "ALL CHECKS PASSED" (exit 0): the user explicitly
// requested a check, it never ran, and the gate reported success. These tests
// pin the fail-closed contract at BOTH boundaries — the CLI and the runChecks
// API — and pin that a real command still runs (so the fix cannot over-reject).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { runChecks, isBlankTestCmd, EMPTY_TEST_CMD_MESSAGE } from '../lib/runner.mjs';

const CLI_PATH = new URL('../bin/preflight.mjs', import.meta.url).pathname;
const REQUIRED_ROWS = ['bash', 'git', 'write', 'branch'];

function initRepo(dir) {
  const g = (args) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'test');
  g(['add', '.']);
  g(['commit', '-m', 'init']);
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

describe('empty --test-cmd is an operational error, not a skipped check (#712)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'preflight-empty-'));
    initRepo(dir);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  // ── AC1 ───────────────────────────────────────────────────────────────────
  it('AC1: CLI --test-cmd "" exits 1, names the flag on stderr, prints nothing on stdout', () => {
    const res = runCli(dir, ['--test-cmd', '']);
    assert.equal(res.status, 1, `expected exit 1, got ${res.status}\nstdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stderr, /--test-cmd requires a non-empty command/);
    // The bin must reject BEFORE runChecks — the lib guard's throw would surface
    // as an "internal error", which is the wrong diagnosis for a user input error.
    assert.doesNotMatch(res.stderr, /internal error/);
    assert.equal(res.stdout, '', 'no table, no verdict line on stdout');
  });

  // ── AC2 ───────────────────────────────────────────────────────────────────
  it('AC2: whitespace-only --test-cmd behaves like empty', () => {
    const res = runCli(dir, ['--test-cmd', '   \t ']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--test-cmd requires a non-empty command/);
    assert.equal(res.stdout, '');
  });

  it('AC2: --test-cmd "" --json exits 1 with EMPTY stdout (no verdict document)', () => {
    const res = runCli(dir, ['--test-cmd', '', '--json']);
    assert.equal(res.status, 1);
    assert.equal(res.stdout, '', 'a machine reader must not see a verdict document');
    assert.match(res.stderr, /--test-cmd requires a non-empty command/);
  });

  // ── AC3 ───────────────────────────────────────────────────────────────────
  it('AC3: runChecks({ testCmd: "" }) rejects — the API fails closed on its own', async () => {
    await assert.rejects(() => runChecks({ cwd: dir, testCmd: '' }), /non-empty command/);
  });

  it('AC3: runChecks rejects whitespace-only and non-string testCmd values', async () => {
    await assert.rejects(() => runChecks({ cwd: dir, testCmd: ' \n\t' }), /non-empty command/);
    await assert.rejects(() => runChecks({ cwd: dir, testCmd: 42 }), /non-empty command/);
    await assert.rejects(() => runChecks({ cwd: dir, testCmd: null }), /non-empty command/);
  });

  it('AC3: runChecks with testCmd ABSENT still yields exactly the four required rows', async () => {
    const results = await runChecks({ cwd: dir });
    assert.deepEqual(results.map((r) => r.name), REQUIRED_ROWS);
    assert.ok(results.every((r) => r.required === true));
  });

  it('AC3: the rejection message is the one shared constant the bin prints', async () => {
    await assert.rejects(() => runChecks({ cwd: dir, testCmd: '' }), (err) => {
      assert.equal(err.message, EMPTY_TEST_CMD_MESSAGE);
      return true;
    });
    const res = runCli(dir, ['--test-cmd', '']);
    assert.ok(res.stderr.includes(EMPTY_TEST_CMD_MESSAGE), `stderr should carry the shared message:\n${res.stderr}`);
  });

  // ── the single predicate both boundaries use ──────────────────────────────
  it('isBlankTestCmd: absent is NOT blank; present-but-empty, whitespace, and non-strings ARE', () => {
    assert.equal(isBlankTestCmd(undefined), false, 'absent flag — nothing was requested');
    assert.equal(isBlankTestCmd('npm test'), false);
    assert.equal(isBlankTestCmd('true'), false);
    assert.equal(isBlankTestCmd(''), true);
    assert.equal(isBlankTestCmd('   '), true);
    assert.equal(isBlankTestCmd('\t\n'), true);
    assert.equal(isBlankTestCmd(null), true);
    assert.equal(isBlankTestCmd(42), true);
  });

  // ── AC4 regression: a real command still runs and is REQUIRED ─────────────
  it('AC4: --test-cmd "true" produces a PASS test-cmd row and exit 0', () => {
    const res = runCli(dir, ['--test-cmd', 'true', '--json']);
    assert.equal(res.status, 0, `stderr:${res.stderr}`);
    const doc = JSON.parse(res.stdout);
    const row = doc.checks.find((c) => c.name === 'test-cmd');
    assert.ok(row, 'test-cmd row present');
    assert.equal(row.status, 'pass');
    assert.equal(row.required, true);
    assert.equal(doc.verdict, 'pass');
  });

  it('AC4: --test-cmd "false" produces a FAIL test-cmd row and exit 2', () => {
    const res = runCli(dir, ['--test-cmd', 'false']);
    assert.equal(res.status, 2, `stdout:${res.stdout}\nstderr:${res.stderr}`);
    assert.match(res.stdout, /test-cmd\s+✗ FAIL/);
    assert.match(res.stdout, /verdict: FAILED .*test-cmd/);
  });

  it('AC4: runChecks with a real command appends a required test-cmd row after the four required rows', async () => {
    const results = await runChecks({ cwd: dir, testCmd: 'true' });
    assert.deepEqual(results.map((r) => r.name), [...REQUIRED_ROWS, 'test-cmd']);
    const row = results.at(-1);
    assert.equal(row.status, 'pass');
    assert.equal(row.required, true);
  });
});
