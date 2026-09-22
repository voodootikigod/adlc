// Contract test for issue #673 / T-01M3339NSAEW4EQ61TCAHK2TBC:
// AC1 & AC2: lesson-foundry --gate fails on unparseable lines, succeeds when <= tolerate-malformed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve(new URL('../bin/lesson-foundry.mjs', import.meta.url).pathname);

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: result.stdout, stderr: result.stderr, code: result.status };
}

// ---------------------------------------------------------------------------
// AC1: lesson-foundry --gate fails with exit 2 when findings ledger contains unparseable lines
// ---------------------------------------------------------------------------
test('AC1: --gate fails with exit 2 when findings ledger contains unparseable lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-gate-ac1-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'not valid json\n{"invalid": "no desc"}\n', 'utf8');
    const { code, stderr } = runCli(['--gate'], dir);
    assert.strictEqual(code, 2, `expected exit code 2, got ${code}; stderr: ${stderr}`);
    assert.match(stderr, /findings ledger contains 2 malformed line\(s\)/, `stderr must state malformed line count; got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC2: lesson-foundry --gate --tolerate-malformed 2 succeeds when skipped <= threshold
// ---------------------------------------------------------------------------
test('AC2: --gate --tolerate-malformed 2 succeeds when skipped count is <= threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-gate-ac2-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'corrupt line 1\ncorrupt line 2\n', 'utf8');
    const { code, stderr } = runCli(['--gate', '--tolerate-malformed', '2'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: --gate --tolerate-malformed 0 is accepted as a valid non-negative integer (kills off-by-one mutant)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-gate-ac2-zero-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), '', 'utf8');
    const { code, stderr } = runCli(['--gate', '--tolerate-malformed', '0'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
    assert.ok(!stderr.includes('error:'), `stderr should not contain error: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: --gate --tolerate-malformed 1 fails with exit 2 when skipped count > threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-gate-ac2-fail-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'corrupt line 1\ncorrupt line 2\n', 'utf8');
    const { code, stderr } = runCli(['--gate', '--tolerate-malformed', '1'], dir);
    assert.strictEqual(code, 2, `expected exit code 2, got ${code}; stderr: ${stderr}`);
    assert.match(stderr, /findings ledger contains 2 malformed line\(s\)/, `stderr must state malformed line count; got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
