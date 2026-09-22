// hollow-test/test/baseline-output.test.mjs
// Verifies that hollow-test captures and reports the baseline test command's
// stdout and stderr when the baseline suite is not green (#288).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { classifyTestResult, runTest, formatDiagnosticOutput, MAX_BASELINE_OUTPUT_BYTES } from '../lib/runner.mjs';

const BIN = resolve(new URL('.', import.meta.url).pathname, '../bin/hollow-test.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir) {
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['config', 'gpg.format', 'openpgp'], dir);
}

function commitAll(dir, msg = 'c') {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
}

function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 60000 });
}

describe('runner: capture stdout and stderr', () => {
  it('runTest captures stdout and stderr on exit 0', () => {
    const res = runTest('node -e "console.log(\'out-ok\'); console.error(\'err-ok\');"', 10000, process.cwd());
    assert.equal(res.status, 0);
    assert.match(res.stdout, /out-ok/);
    assert.match(res.stderr, /err-ok/);
  });

  it('runTest captures stdout and stderr on non-zero exit', () => {
    const res = runTest('node -e "console.log(\'out-fail\'); console.error(\'err-fail\'); process.exit(2);"', 10000, process.cwd());
    assert.equal(res.status, 2);
    assert.match(res.stdout, /out-fail/);
    assert.match(res.stderr, /err-fail/);
  });

  it('classifyTestResult propagates stdout and stderr from spawnSync result', () => {
    const synthetic = {
      status: 1,
      signal: null,
      stdout: 'some stdout text\n',
      stderr: 'some stderr text\n',
    };
    const classified = classifyTestResult(synthetic);
    assert.equal(classified.stdout, 'some stdout text\n');
    assert.equal(classified.stderr, 'some stderr text\n');
  });

  it('classifyTestResult defaults stdout and stderr to empty strings when missing', () => {
    const classified = classifyTestResult({ status: 0, signal: null });
    assert.equal(classified.stdout, '');
    assert.equal(classified.stderr, '');
  });
});

describe('CLI: baseline test output reporting on failure (#288)', () => {
  it('emits baseline test stdout to stderr when baseline fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hollow-baseline-stdout-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 1;\n');
      commitAll(dir, 'initial');
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 2;\n');
      commitAll(dir, 'update');

      const result = runCli([
        '--test-cmd', 'node -e "console.log(\'BASELINE STDOUT FAILURE DETAILS\'); process.exit(1);"',
        '--base', 'HEAD~1',
        '--max', '5',
      ], dir);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /BASELINE STDOUT FAILURE DETAILS/);
      assert.match(result.stderr, /baseline suite is not green/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits baseline test stderr to stderr when baseline fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hollow-baseline-stderr-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 1;\n');
      commitAll(dir, 'initial');
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 2;\n');
      commitAll(dir, 'update');

      const result = runCli([
        '--test-cmd', 'node -e "console.error(\'BASELINE STDERR FAILURE TRACE\'); process.exit(1);"',
        '--base', 'HEAD~1',
        '--max', '5',
      ], dir);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /BASELINE STDERR FAILURE TRACE/);
      assert.match(result.stderr, /baseline suite is not green/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits both stdout and stderr when baseline test command outputs both', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hollow-baseline-both-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 1;\n');
      commitAll(dir, 'initial');
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 2;\n');
      commitAll(dir, 'update');

      const result = runCli([
        '--test-cmd', 'node -e "console.log(\'BASELINE BOTH STDOUT\'); console.error(\'BASELINE BOTH STDERR\'); process.exit(1);"',
        '--base', 'HEAD~1',
        '--max', '5',
      ], dir);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /BASELINE BOTH STDOUT/);
      assert.match(result.stderr, /BASELINE BOTH STDERR/);
      assert.match(result.stderr, /baseline suite is not green/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('truncates oversized baseline output preserving failure head and tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hollow-baseline-large-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 1;\n');
      commitAll(dir, 'initial');
      writeFileSync(join(dir, 'file.mjs'), 'export const a = 2;\n');
      commitAll(dir, 'update');

      const result = runCli([
        '--test-cmd', 'node -e "console.log(\'EARLY_FAILURE_HEAD \' + \'x\'.repeat(100000) + \' LATE_FAILURE_TAIL\'); process.exit(1);"',
        '--base', 'HEAD~1',
        '--max', '5',
      ], dir);

      assert.equal(result.status, 1);
      assert.match(result.stderr, /EARLY_FAILURE_HEAD/);
      assert.match(result.stderr, /LATE_FAILURE_TAIL/);
      assert.match(result.stderr, /\[\.\.\. hollow-test: truncated \d+ bytes of output \.\.\.\]/);
      assert.match(result.stderr, /baseline suite is not green/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('formatDiagnosticOutput', () => {
  it('returns short output unchanged with trailing newline', () => {
    assert.equal(formatDiagnosticOutput('hello'), 'hello\n');
    assert.equal(formatDiagnosticOutput('hello\n'), 'hello\n');
  });

  it('handles empty or non-string gracefully', () => {
    assert.equal(formatDiagnosticOutput(''), '');
    assert.equal(formatDiagnosticOutput(null), '');
    assert.equal(formatDiagnosticOutput(undefined), '');
  });

  it('truncates output exceeding maxBytes and preserves head and tail with a marker', () => {
    const head = 'HEAD_START' + 'A'.repeat(50);
    const tail = 'B'.repeat(50) + 'TAIL_END';
    const text = head + 'MIDDLE'.repeat(200) + tail;
    const formatted = formatDiagnosticOutput(text, 100);
    assert.match(formatted, /^HEAD_START/);
    assert.match(formatted, /TAIL_END\n?$/);
    assert.match(formatted, /\[\.\.\. hollow-test: truncated \d+ bytes of output \.\.\.\]/);
  });

  it('splits head and tail equally when truncating', () => {
    const input = 'A'.repeat(100) + 'B'.repeat(100);
    const maxBytes = 20;
    const formatted = formatDiagnosticOutput(input, maxBytes);
    assert.ok(formatted.startsWith('A'.repeat(10) + '\n[...'));
    assert.ok(formatted.endsWith('B'.repeat(10) + '\n'));
  });
});
