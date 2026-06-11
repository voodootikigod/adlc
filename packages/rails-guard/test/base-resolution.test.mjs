// Regression tests for the freeze-baseline resolution (CRITICAL bug).
//
// Bug: the gate defaulted --base to 'HEAD'. `git diff HEAD` only shows
// working-tree changes, so a builder who COMMITS an edit to a frozen rail file
// leaves a clean working tree and the gate passes with exit 0 — defeating the
// single most load-bearing enforcement in the lifecycle.
//
// Fix: when --base is omitted, resolve the merge-base with trunk; if no trunk
// ref exists, fail closed (exit 1) rather than silently diffing against HEAD.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/rails-guard.mjs', import.meta.url));

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupRepo(initialBranch = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'rails-guard-base-'));
  git(['init', '-b', initialBranch], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  return dir;
}

function writeFile(dir, rel, content) {
  const full = join(dir, rel);
  mkdirSync(full.substring(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

function commit(dir, msg) {
  git(['add', '-A'], dir);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', msg], dir);
}

/** Invoke the bin in a given cwd and return { status, stdout, stderr }. */
function runBin(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

describe('freeze baseline: committed rail edits are caught (no --base)', () => {
  let dir;

  before(() => {
    dir = setupRepo('main');
    // Baseline on main: a frozen rail file and a source file.
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => {});\n');
    writeFile(dir, 'src/auth.ts', 'export function login() {}\n');
    commit(dir, 'initial');

    // Diverge onto a feature branch and COMMIT an edit to the rail file. With a
    // clean working tree, the old `git diff HEAD` default would see nothing.
    git(['checkout', '-b', 'feat/x'], dir);
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => { it("sneaky"); });\n');
    commit(dir, 'sneaky rail edit');
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('committed rail edit is caught with NO --base (exit 2, rail-edit)', () => {
    // Working tree is clean here — the edit only lives in a commit.
    const result = runBin(['--rails', 'test/**', '--json'], dir);
    assert.equal(
      result.status, 2,
      `expected exit 2 (gate fails); got ${result.status}. stderr: ${result.stderr}`
    );

    const parsed = JSON.parse(result.stdout);
    const railViolations = (parsed.violations ?? []).filter((v) => v.type === 'rail-edit');
    assert.equal(railViolations.length, 1, 'the committed rail edit must be reported');
    assert.equal(railViolations[0].file, 'test/auth.test.ts');
  });

  test('explicit --base still works (diff against main catches the edit)', () => {
    const result = runBin(['--rails', 'test/**', '--base', 'main', '--json'], dir);
    assert.equal(result.status, 2, `expected exit 2; stderr: ${result.stderr}`);

    const parsed = JSON.parse(result.stdout);
    const railViolations = (parsed.violations ?? []).filter((v) => v.type === 'rail-edit');
    assert.equal(railViolations.length, 1);
    assert.equal(railViolations[0].file, 'test/auth.test.ts');
  });

  test('resolved base (not literal HEAD) is recorded in the manifest', () => {
    // Branch from main and commit a NON-rail change only, so the gate passes
    // and --record writes an entry whose base is the resolved merge-base.
    git(['checkout', 'main'], dir);
    git(['checkout', '-b', 'feat/clean'], dir);
    writeFile(dir, 'src/auth.ts', 'export function login() { return true; }\n');
    commit(dir, 'non-rail change');

    const result = runBin(['--rails', 'test/**', '--record'], dir);
    assert.equal(result.status, 0, `expected clean pass; stderr: ${result.stderr}`);

    const manifest = join(dir, '.aidlc', 'manifest.jsonl');
    const lines = execFileSync('cat', [manifest], { encoding: 'utf8' }).trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.type, 'rails-check');
    assert.notEqual(entry.base, 'HEAD', 'recorded base must be the resolved merge-base, not HEAD');
    // A resolved merge-base is a 40-char commit sha.
    assert.match(entry.base, /^[0-9a-f]{40}$/, 'base should be a resolved commit sha');
  });
});

describe('freeze baseline: fail closed when no trunk ref and no --base', () => {
  let dir;

  before(() => {
    // Initial branch is NOT main/master, so resolveBase() finds no candidate.
    dir = setupRepo('develop');
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => {});\n');
    commit(dir, 'initial');
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('exits 1 (opError) when no main/master and no --base', () => {
    const result = runBin(['--rails', 'test/**'], dir);
    assert.equal(
      result.status, 1,
      `expected exit 1 (fail closed); got ${result.status}. stderr: ${result.stderr}`
    );
    assert.match(result.stderr, /freeze baseline|--base/, 'error must tell the user to pass --base');
  });

  test('explicit --base still works even without a trunk ref', () => {
    // Diverge and commit a rail edit; diff against the first commit catches it.
    const firstSha = git(['rev-parse', 'HEAD'], dir).trim();
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => { it("x"); });\n');
    commit(dir, 'edit rail');

    const result = runBin(['--rails', 'test/**', '--base', firstSha, '--json'], dir);
    assert.equal(result.status, 2, `expected exit 2; stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal((parsed.violations ?? []).filter((v) => v.type === 'rail-edit').length, 1);
  });
});
