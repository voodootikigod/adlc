// test/cli.test.mjs — CLI integration tests using fixture log files.
// Spawns the CLI as a subprocess; verifies exit codes and output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../bin/flail-detector.mjs', import.meta.url).pathname;

/**
 * Run the CLI with given args and optional stdin content.
 */
function run(args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: cwd ?? process.cwd(),
  });
}

let tmpDir;
test.before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'flail-detector-test-'));
});

test.after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// No args — should print usage and exit 1
// ---------------------------------------------------------------------------

test('CLI: no args prints usage error and exits 1', () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage|flail-detector/i);
});

// ---------------------------------------------------------------------------
// Missing file — exit 1
// ---------------------------------------------------------------------------

test('CLI: missing log file exits 1', () => {
  const r = run(['/nonexistent/path/to/log.txt']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/i);
});

// ---------------------------------------------------------------------------
// Clean plain-text log — exit 0
// ---------------------------------------------------------------------------

test('CLI: clean plain-text log exits 0', () => {
  const f = join(tmpDir, 'clean.log');
  writeFileSync(f, [
    'Build started',
    'Compiling modules...',
    'Done in 2.3s',
    'All tests passed.',
  ].join('\n'));

  const r = run([f]);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /CLEAN/);
});

// ---------------------------------------------------------------------------
// Repeated-error plain-text log — exit 2
// ---------------------------------------------------------------------------

test('CLI: repeated error in plain-text log exits 2', () => {
  const f = join(tmpDir, 'repeated-error.log');
  writeFileSync(f, [
    'Build started',
    'Error: cannot connect to database at line 42',
    'Retrying...',
    'Error: cannot connect to database at line 42',
    'Build failed.',
  ].join('\n'));

  const r = run([f]);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /FLAIL/);
  assert.match(r.stdout, /repeated-error/);
});

// ---------------------------------------------------------------------------
// Repeated-error with --max-repeat 3 (should be clean at count=2)
// ---------------------------------------------------------------------------

test('CLI: --max-repeat 3 does not flail at 2 occurrences', () => {
  const f = join(tmpDir, 'repeat-thresh.log');
  writeFileSync(f, [
    'Error: failed to build',
    'Error: failed to build',
  ].join('\n'));

  const r = run([f, '--max-repeat', '3']);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// JSONL log with repeated error — exit 2
// ---------------------------------------------------------------------------

test('CLI: JSONL log with repeated error exits 2', () => {
  const f = join(tmpDir, 'jsonl-error.log');
  const entries = [
    { message: 'Build started' },
    { message: 'Error: ENOENT file not found /home/user/foo.ts' },
    { message: 'Retrying...' },
    { message: 'Error: ENOENT file not found /home/user/bar.ts' },
  ];
  writeFileSync(f, entries.map((e) => JSON.stringify(e)).join('\n'));

  const r = run([f]);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /FLAIL/);
});

// ---------------------------------------------------------------------------
// Scope violation — exit 2
// ---------------------------------------------------------------------------

test('CLI: scope violation exits 2', () => {
  const f = join(tmpDir, 'scope-violation.log');
  writeFileSync(f, [
    'Writing src/index.js',
    'Writing /etc/passwd',
  ].join('\n'));

  const r = run([f, '--scope', 'src/**']);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /scope-violation/);
});

// ---------------------------------------------------------------------------
// Scope — in scope is clean
// ---------------------------------------------------------------------------

test('CLI: in-scope writes stay clean', () => {
  const f = join(tmpDir, 'in-scope.log');
  writeFileSync(f, [
    'Writing src/index.js',
    'Editing src/utils.js',
  ].join('\n'));

  const r = run([f, '--scope', 'src/**']);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Edit churn — exit 2
// ---------------------------------------------------------------------------

test('CLI: edit churn exits 2', () => {
  const f = join(tmpDir, 'churn.log');
  writeFileSync(f, [
    'Writing src/foo.js',
    'Editing src/foo.js',
    'Writing src/foo.js',
  ].join('\n'));

  const r = run([f]);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /edit-churn/);
});

// ---------------------------------------------------------------------------
// Size signal — exit 2
// ---------------------------------------------------------------------------

test('CLI: size exceeded exits 2', () => {
  const f = join(tmpDir, 'big.log');
  writeFileSync(f, 'Build started\n'.repeat(100));

  const r = run([f, '--max-bytes', '10']);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /size/);
});

// ---------------------------------------------------------------------------
// --json flag
// ---------------------------------------------------------------------------

test('CLI: --json flag outputs valid JSON', () => {
  const f = join(tmpDir, 'json-output.log');
  writeFileSync(f, 'Build succeeded\n');

  const r = run([f, '--json']);
  assert.equal(r.status, 0);
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(r.stdout); });
  assert.ok(parsed.verdict === 'clean' || parsed.verdict === 'flail');
});

test('CLI: --json flag on flail includes signals and recommendation', () => {
  const f = join(tmpDir, 'json-flail.log');
  writeFileSync(f, [
    'Error: failed',
    'Error: failed',
  ].join('\n'));

  const r = run([f, '--json']);
  assert.equal(r.status, 2);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'flail');
  assert.ok(Array.isArray(parsed.signals));
  assert.ok(parsed.recommendation);
});

// ---------------------------------------------------------------------------
// Recommendation block present on flail
// ---------------------------------------------------------------------------

test('CLI: flail output includes recommendation', () => {
  const f = join(tmpDir, 'rec.log');
  writeFileSync(f, [
    'Exception: null pointer',
    'Exception: null pointer',
  ].join('\n'));

  const r = run([f]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Kill the session/);
});

// ---------------------------------------------------------------------------
// Normalization: different variants collapse to same signature
// ---------------------------------------------------------------------------

test('CLI: variants of same error collapse (normalization)', () => {
  const f = join(tmpDir, 'normalize.log');
  writeFileSync(f, [
    'Cannot find module "lodash" at line 10',
    'Cannot find module "express" at line 25',
    'Cannot find module "react" at line 33',
  ].join('\n'));

  // All three should normalize to same signature → flail at maxRepeat=2
  const r = run([f]);
  assert.equal(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /repeated-error/);
});
