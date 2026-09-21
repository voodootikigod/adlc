// Contract test for issue #673 / T-01M3339NSAEW4EQ61TCAHK2TBC:
// lesson-foundry: fail gate when findings ledger contains unparseable or malformed lines.

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
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
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

// ---------------------------------------------------------------------------
// Normative 3: --json mode with --gate surfaces skipped and triggers gate failure
// ---------------------------------------------------------------------------
test('Normative 3: --json --gate surfaces skipped malformed count and sets gate.pass false on exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'corrupt json\n', 'utf8');
    const { code, stdout, stderr } = runCli(['--json', '--gate'], dir);
    assert.strictEqual(code, 2, `expected exit code 2, got ${code}; stderr: ${stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, `stdout must be valid JSON; got: ${stdout}`);
    assert.strictEqual(parsed.skippedMalformed, 1);
    assert.ok(parsed.gate !== null, 'gate should be present');
    assert.strictEqual(parsed.gate.pass, false, 'gate.pass must be false');
    assert.strictEqual(parsed.gate.skippedMalformed, 1, 'gate.skippedMalformed must be 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Normative 3: --json --gate with --tolerate-malformed sets gate.pass true when within tolerance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'corrupt json\n', 'utf8');
    const { code, stdout, stderr } = runCli(['--json', '--gate', '--tolerate-malformed', '1'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(stdout); }, `stdout must be valid JSON; got: ${stdout}`);
    assert.strictEqual(parsed.skippedMalformed, 1);
    assert.ok(parsed.gate !== null, 'gate should be present');
    assert.strictEqual(parsed.gate.pass, true, 'gate.pass must be true');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Advisory mode (without --gate): malformed lines are reported but exit 0
// ---------------------------------------------------------------------------
test('Advisory mode: without --gate, malformed lines do not cause exit 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'corrupt json\n', 'utf8');
    const { code, stdout, stderr } = runCli([], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
    assert.match(stdout, /skipped 1 malformed ledger line\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --prompt-only mode with --gate enforces malformed ledger check
// ---------------------------------------------------------------------------
test('--prompt-only with --gate fails with exit 2 when findings ledger contains malformed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'corrupt json line\n', 'utf8');
    const { code, stderr } = runCli(['--gate', '--prompt-only'], dir);
    assert.strictEqual(code, 2, `expected exit code 2, got ${code}; stderr: ${stderr}`);
    assert.match(stderr, /findings ledger contains 1 malformed line\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--prompt-only with --gate --tolerate-malformed succeeds when skipped <= threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), 'corrupt json line\n', 'utf8');
    const { code, stdout, stderr } = runCli(['--gate', '--prompt-only', '--tolerate-malformed', '1'], dir);
    assert.strictEqual(code, 0, `expected exit code 0, got ${code}; stderr: ${stderr}`);
    assert.ok(!stderr.includes('error:'), `stderr should not contain error: ${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Error handling: bad --tolerate-malformed argument
// ---------------------------------------------------------------------------
test('CLI exit 1: --tolerate-malformed with non-integer value exits 1 with opError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), '', 'utf8');
    const { code, stderr } = runCli(['--tolerate-malformed', 'invalid'], dir);
    assert.strictEqual(code, 1, `expected exit code 1, got ${code}; stderr: ${stderr}`);
    assert.match(stderr, /--tolerate-malformed must be a non-negative integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exit 1: --tolerate-malformed with negative value exits 1 with opError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lesson-foundry-malformed-test-'));
  try {
    const adlcDir = join(dir, '.adlc');
    mkdirSync(adlcDir, { recursive: true });
    writeFileSync(join(adlcDir, 'findings.jsonl'), '', 'utf8');
    const { code, stderr } = runCli(['--tolerate-malformed=-1'], dir);
    assert.strictEqual(code, 1, `expected exit code 1, got ${code}; stderr: ${stderr}`);
    assert.match(stderr, /--tolerate-malformed must be a non-negative integer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
