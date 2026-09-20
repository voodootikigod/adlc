// Contract test for issue #671 / T-01M30DP89XV8ANWYQEFBAGSE2Y:
// lesson-foundry must fail with opError when --gate ledger is missing unless --allow-missing-ledger is set.

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
// AC1: lesson-foundry --gate --ledger nonexistent exits 1 with opError
// ---------------------------------------------------------------------------
test('AC1: --gate with nonexistent --ledger exits 1 with operational error naming ledger file not found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-missing-ledger-test-'));
  try {
    const { code, stderr } = runCli(['--gate', '--ledger', 'nonexistent'], dir);
    assert.strictEqual(code, 1, `expected exit code 1, got ${code}; stderr: ${stderr}`);
    assert.match(stderr, /error:\s+ledger file not found:/, 'stderr must state ledger file not found');
    const expectedPath = join(dir, '.adlc', 'nonexistent.jsonl');
    assert.ok(stderr.includes(expectedPath), `stderr must include resolved path ${expectedPath}; got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC1: --gate with default findings ledger missing exits 1 naming default ledger path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-missing-ledger-test-'));
  try {
    const { code, stderr } = runCli(['--gate'], dir);
    assert.strictEqual(code, 1, `expected exit code 1, got ${code}; stderr: ${stderr}`);
    assert.match(stderr, /error:\s+ledger file not found:/, 'stderr must state ledger file not found');
    const expectedPath = join(dir, '.adlc', 'findings.jsonl');
    assert.ok(stderr.includes(expectedPath), `stderr must include resolved path ${expectedPath}; got: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC2: lesson-foundry --gate --allow-missing-ledger --ledger nonexistent exits 0
// ---------------------------------------------------------------------------
test('AC2: --gate --allow-missing-ledger with nonexistent --ledger exits 0 (bootstrap opt-in)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-missing-ledger-test-'));
  try {
    const { code, stdout, stderr } = runCli(['--gate', '--allow-missing-ledger', '--ledger', 'nonexistent'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
    assert.ok(!stderr.includes('error:'), `stderr should not contain errors: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC2: --gate --allow-missing-ledger with default findings ledger missing exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-missing-ledger-test-'));
  try {
    const { code, stdout, stderr } = runCli(['--gate', '--allow-missing-ledger'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
    assert.ok(!stderr.includes('error:'), `stderr should not contain errors: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Normative 3: Non-gate mode with missing ledger continues to exit 0
// ---------------------------------------------------------------------------
test('Normative 3: without --gate, missing ledger continues to return empty entries without error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-missing-ledger-test-'));
  try {
    const { code, stdout, stderr } = runCli(['--ledger', 'nonexistent'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
    assert.ok(!stderr.includes('error:'), `stderr should not contain errors: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Existing ledger behavior remains intact
// ---------------------------------------------------------------------------
test('Existing ledger: --gate with existing empty ledger exits 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-missing-ledger-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), '', 'utf8');
    const { code, stderr } = runCli(['--gate'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
