// key-ceremony-cli.test.mjs — the leakage test the spec requires: the generated (or
// imported) key must NEVER appear on any ceremony output stream (T3 slice B, spec
// .adlc/specs/manifest-key-hermeticity.md Layer 3). Exercises the REAL binary via
// spawnSync, capturing both stdout AND stderr — no existing test in this codebase
// checks both streams for a secret's absence; this is the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function run(args, cwd, env = process.env) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function assertNeverAppears(secret, ...haystacks) {
  for (const hay of haystacks) {
    assert.ok(!hay.includes(secret), `secret must never appear in output: ${JSON.stringify(hay)}`);
  }
}

// Negative control (round 6 finding): proves assertNeverAppears itself would catch a
// leak wrapped in JSON or followed by other text, not just an exact standalone match —
// this is what every real leakage assertion in this file relies on.
test('assertNeverAppears helper: detects a bare key embedded inside JSON or trailing text, not just an exact match', () => {
  const key = 'a'.repeat(64);
  assert.throws(() => assertNeverAppears(key, `{"debug":"key=${key}"}`), /secret must never appear/);
  assert.throws(() => assertNeverAppears(key, `prefix ${key} suffix`), /secret must never appear/);
  assert.doesNotThrow(() => assertNeverAppears(key, 'no secret here'));
});

test('CLI: generate-key writes a real key to the handoff file, and the key never appears on stdout or stderr', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  try {
    const result = run(['generate-key', '--output', handoffPath], repoDir);
    assert.equal(result.status, 0, result.stderr);
    const rawFileContent = readFileSync(handoffPath, 'utf8');
    // The file is line-oriented (trailing '\n') so the documented `read -r` loader
    // doesn't hit EOF before a delimiter — see key-ceremony.mjs's writeKeyHandoffFile.
    assert.match(rawFileContent, /^[0-9a-f]{64}\n$/, 'the handoff file must contain a real generated key, newline-terminated');
    // Check the bare key VALUE (not the file's newline-terminated bytes) — a leak
    // wrapped in JSON or followed by other text would not contain the literal
    // `<key>\n` substring, so asserting on that alone would miss it (round 6 finding).
    const key = rawFileContent.replace(/\n$/, '');
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
    // The bare key VALUE, not the file's newline-terminated bytes (round 6 finding —
    // checking for `<key>\n` would miss a leak wrapped in JSON or followed by text).
    const key = readFileSync(handoffPath, 'utf8').replace(/\n$/, '');
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

test('CLI: the audited import exception reads the CALLER-SUPPLIED key from ADLC_MANIFEST_KEY (never a CLI argument), warns on stderr, and still never leaks the key itself', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  const importedKey = 'a-legacy-key-that-predates-this-ceremony';
  const env = { ...process.env, ADLC_MANIFEST_KEY: importedKey };
  try {
    const result = run(['generate-key', '--output', handoffPath, '--allow-key-import'], repoDir, env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(handoffPath, 'utf8'), `${importedKey}\n`);
    assertNeverAppears(importedKey, result.stdout, result.stderr);
    assert.match(result.stderr, /AUDITED IMPORT EXCEPTION/, 'the exception must be visibly flagged for future doctor reporting');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: refuses a multiline imported key — it would silently truncate to its first line through the line-oriented handoff file', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  const multilineKey = 'first-line-of-a-legacy-secret\nsecond-line-that-would-be-silently-dropped';
  const env = { ...process.env, ADLC_MANIFEST_KEY: multilineKey };
  try {
    const result = run(['generate-key', '--output', handoffPath, '--allow-key-import'], repoDir, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not contain a newline/);
    assert.equal(existsSync(handoffPath), false, 'nothing should be written when the imported key is refused');
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: never accepts an import key as a CLI ARGUMENT — no such flag exists at all', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  const attemptedKey = 'a-key-nobody-authorized-importing';
  try {
    // --import-key is not a recognized option; parseArgs must reject it outright.
    const result = run(['generate-key', '--output', handoffPath, '--import-key', attemptedKey], repoDir);
    assert.notEqual(result.status, 0);
    assertNeverAppears(attemptedKey, result.stdout, result.stderr);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('CLI: --allow-key-import without ADLC_MANIFEST_KEY set in the environment is refused', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  const env = { ...process.env };
  delete env.ADLC_MANIFEST_KEY;
  try {
    const result = run(['generate-key', '--output', handoffPath, '--allow-key-import'], repoDir, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires ADLC_MANIFEST_KEY/);
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
      result.stderr.includes('generate-key --output <path> [--allow-key-import] [--json]'),
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
      result.stderr.includes('generate-key --output <path> [--allow-key-import] [--json]'),
      `expected the exact usage string in stderr, got: ${result.stderr}`,
    );
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('CLI: refuses a handoff path inside a LINKED WORKTREE of the same repository, via the real binary', () => {
  const repoDir = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-cli-repo-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
  execFileSync(
    'git',
    ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'],
    { cwd: repoDir },
  );
  const linkedPath = mkdtempSync(join(tmpdir(), 'adlc-key-ceremony-cli-linked-'));
  rmSync(linkedPath, { recursive: true, force: true });
  execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'cli-linked-test-branch', linkedPath], { cwd: repoDir });
  try {
    const destination = join(linkedPath, 'key.txt');
    // Run FROM the primary repoDir, targeting a path inside the SIBLING linked worktree.
    const result = run(['generate-key', '--output', destination], repoDir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the repository/i);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', linkedPath], { cwd: repoDir });
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test('the documented loading snippet (README/docs "Signing & provenance") runs to completion under `set -e -x`, never tracing the key', () => {
  const { repoDir, outsideDir } = makeDirs();
  const handoffPath = join(outsideDir, 'key.txt');
  try {
    const generate = run(['generate-key', '--output', handoffPath], repoDir);
    assert.equal(generate.status, 0, generate.stderr);
    const key = readFileSync(handoffPath, 'utf8');

    // Exactly the loading snippet documented in both README/docs copies, run under BOTH
    // `set -e` and `set -x` — round 5 finding: the handoff file's raw key bytes have no
    // trailing newline, so `read -r` hits EOF before a delimiter and returns exit status
    // 1; under `set -e` (the ordinary case for CI/maintenance scripts) that silently
    // aborted the snippet before export/delete/record ever ran, and the prior version of
    // this test (no `set -e`) could not have caught it. Also proves the snippet reaches
    // its FINAL line (rm) and that deletion actually happens, not just that read/export
    // succeed.
    const traced = spawnSync('bash', ['-c', `
      set -e
      set -x
      IFS= read -r ADLC_MANIFEST_KEY < "${handoffPath}"
      export ADLC_MANIFEST_KEY
      rm "${handoffPath}"
      echo "REACHED_END:\${#ADLC_MANIFEST_KEY}"
    `], { encoding: 'utf8' });
    assert.equal(traced.status, 0, traced.stderr);
    assert.match(traced.stdout, /REACHED_END:64/, 'the snippet must run to its final line with the full 64-char key loaded, not abort partway under set -e');
    assert.equal(existsSync(handoffPath), false, 'the documented snippet deletes the handoff file');
    assertNeverAppears(key, traced.stdout, traced.stderr);
    assertNeverAppears(key.replace(/\n$/, ''), traced.stdout, traced.stderr);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
