// key-ceremony-cli.test.mjs — the leakage test the spec requires: the generated (or
// imported) key must NEVER appear on any ceremony output stream (T3 slice B, spec
// .adlc/specs/manifest-key-hermeticity.md Layer 3). Exercises the REAL binary via
// spawnSync, capturing both stdout AND stderr — no existing test in this codebase
// checks both streams for a secret's absence; this is the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const BIN = new URL('../bin/gate-manifest.mjs', import.meta.url).pathname;

// assertHandoffPathOutsideRepo defaults to repoRoot(cwd), which shells out to
// `git rev-parse --show-toplevel` — that fails outright outside a real git repo, so
// `repoDir` must actually BE one (no commits or config needed for rev-parse alone).
function makeDirs() {
  const repoDir = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-cli-repo-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  const outsideDir = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-cli-outside-'));
  return { repoDir, outsideDir };
}

function run(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function assertNeverAppears(secret, ...haystacks) {
  for (const hay of haystacks) {
    assert.ok(!hay.includes(secret), `secret must never appear in output: ${JSON.stringify(hay)}`);
  }
}

test('CLI: generate-key writes a real key to the handoff file, and the key never appears on stdout or stderr', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  try {
    const result = run(['generate-key', '--output', handoffPath], repoDir);
    assert.equal(result.status, 0, result.stderr);
    const key = readFileSync(handoffPath, 'utf8');
    assert.match(key, /^[0-9a-f]{64}$/, 'the handoff file must contain a real generated key');
    assertNeverAppears(key, result.stdout, result.stderr);
    // Belt-and-braces: the fingerprint printed must be the correct commitment to the
    // key that was actually written, proving the ceremony didn't drift between the two.
    const fingerprint = createHash('sha256').update(key, 'utf8').digest('hex');
    assert.ok(result.stdout.includes(fingerprint), 'the printed fingerprint must match the written key');
    assert.ok(result.stdout.includes(handoffPath), 'the path is safe to print — only the contents are secret');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: --json mode also never leaks the key, and the JSON is well-formed', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  try {
    const result = run(['generate-key', '--output', handoffPath, '--json'], repoDir);
    assert.equal(result.status, 0, result.stderr);
    const key = readFileSync(handoffPath, 'utf8');
    assertNeverAppears(key, result.stdout, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.path, handoffPath);
    assert.equal(parsed.imported, false);
    assert.match(parsed.fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: the audited import exception writes the CALLER-SUPPLIED key, warns on stderr, and still never leaks the key itself', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  const importedKey = 'a-legacy-key-that-predates-this-ceremony';
  try {
    const result = run(
      ['generate-key', '--output', handoffPath, '--import-key', importedKey, '--allow-key-import'],
      repoDir,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(handoffPath, 'utf8'), importedKey);
    assertNeverAppears(importedKey, result.stdout, result.stderr);
    assert.match(result.stderr, /AUDITED IMPORT EXCEPTION/, 'the exception must be visibly flagged for future doctor reporting');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: a caller-supplied key WITHOUT the exception flag is refused, and the attempted key never appears anywhere', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  const attemptedKey = 'a-key-nobody-authorized-importing';
  try {
    const result = run(['generate-key', '--output', handoffPath, '--import-key', attemptedKey], repoDir);
    assert.notEqual(result.status, 0);
    assertNeverAppears(attemptedKey, result.stdout, result.stderr);
    assert.match(result.stderr, /never accepts one/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: refuses a handoff path INSIDE the repository, before writing anything', () => {
  const { repoDir } = makeDirs();
  const insidePath = join(repoDir, 'key.txt');
  try {
    const result = run(['generate-key', '--output', insidePath], repoDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the repository/i);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('CLI: refuses to overwrite an existing file at the handoff path, and leaves it untouched', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  writeFileSync(handoffPath, 'pre-existing content');
  try {
    const result = run(['generate-key', '--output', handoffPath], repoDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to overwrite/);
    assert.equal(readFileSync(handoffPath, 'utf8'), 'pre-existing content');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: --output is required, and the usage message names the exact expected flag syntax', () => {
  const { repoDir } = makeDirs();
  try {
    const result = run(['generate-key'], repoDir);
    assert.notEqual(result.status, 0);
    // Pins the exact usage string, not just that "--output" appears somewhere — guards
    // the literal flag syntax (angle brackets around the placeholder names) against
    // corruption, not merely the presence of an unrelated substring.
    assert.ok(
      result.stderr.includes('generate-key --output <path> [--import-key <hex> --allow-key-import] [--json]'),
      `expected the exact usage string in stderr, got: ${result.stderr}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('CLI: the top-level usage (no verb given) also names the exact generate-key flag syntax', () => {
  const { repoDir } = makeDirs();
  try {
    const result = run([], repoDir);
    assert.notEqual(result.status, 0);
    assert.ok(
      result.stderr.includes('generate-key --output <path> [--import-key <hex> --allow-key-import] [--json]'),
      `expected the exact usage string in stderr, got: ${result.stderr}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});
