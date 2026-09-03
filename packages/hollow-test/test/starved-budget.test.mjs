// hollow-test/test/starved-budget.test.mjs
// Issue #657: a diff-derived file that received ZERO mutation budget from
// buildFileTargets()'s round-robin allocation (quota 0, never attempted) must
// fail closed (exit 1, opError) — not warn on stderr and fall through to
// pass()/exit 0. Distinct from issue #658 (diff-zero-mutants.test.mjs), which
// covers a file that DID receive budget but produced zero mutants because its
// content has no mutable construct.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

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

function commitAll(dir, msg = 'init') {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
}

function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60000,
  });
}

function mathFile(name, op) {
  return [
    `export function ${name}(a, b) {`,
    `  return a ${op} b;`,
    '}',
    '',
  ].join('\n');
}

// A cosmetically different (parenthesized) but semantically identical return
// line — hollow-test scopes mutation to the DIFF's changed lines (hunk-scoped
// targetLines), so a genuinely edited mutable line is required for a file to
// register as changed AND stay mutable; prepending an unrelated comment line
// would leave the return line itself unchanged and out of scope.
function mathFileTouched(name, op) {
  return [
    `export function ${name}(a, b) {`,
    `  return (a ${op} b);`,
    '}',
    '',
  ].join('\n');
}

function mathTest(name, srcFile, a, b, expected) {
  return [
    "import { describe, it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    `import { ${name} } from '../src/${srcFile}';`,
    `describe('${name}', () => {`,
    `  it('computes', () => { assert.strictEqual(${name}(${a}, ${b}), ${expected}); });`,
    '});',
    '',
  ].join('\n');
}

// ── AC1: three changed files, --max 1 — the exact issue #657 repro ─────────
// buildFileTargets() round-robins: maxTotal=1, files.length=3, no priority
// files -> base=0, remainder=1 -> only the FIRST file (alphabetical diff
// order: a.mjs) gets quota 1; b.mjs and c.mjs get quota 0 and are never
// attempted at all.

describe('CLI: diff-derived files starved of mutation budget (--max too small)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-starved-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.mjs'), mathFile('add', '+'));
    writeFileSync(join(dir, 'test', 'a.test.mjs'), mathTest('add', 'a.mjs', 2, 3, 5));
    commitAll(dir, 'init');

    // Second commit changes THREE files at once; only a.mjs has a test. a.mjs
    // gets a REAL content change (a leading comment) so git actually reports
    // it as changed between HEAD~1 and HEAD — a same-content rewrite would
    // leave it out of the diff entirely and skew the file count this test
    // depends on.
    writeFileSync(join(dir, 'src', 'a.mjs'), mathFileTouched('add', '+'));
    writeFileSync(join(dir, 'src', 'b.mjs'), mathFile('sub', '-'));
    writeFileSync(join(dir, 'src', 'c.mjs'), mathFile('mul', '*'));
    commitAll(dir, 'touch a.mjs, add b.mjs and c.mjs (no tests for b/c)');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 (not 0) and names the starved files, instructing to raise --max', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '1'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 (starved diff-derived files), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /received no mutation budget/,
      `Expected the starvation reason in stderr, got: ${result.stderr}`);
    assert.match(result.stderr, /b\.mjs/, `Expected b.mjs named in stderr, got: ${result.stderr}`);
    assert.match(result.stderr, /c\.mjs/, `Expected c.mjs named in stderr, got: ${result.stderr}`);
    assert.match(result.stderr, /raise --max/, `Expected a raise --max instruction, got: ${result.stderr}`);
  });

  it('never prints the success line, in stdout or stderr', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '1'],
      dir
    );
    assert.doesNotMatch(result.stdout, /All mutants killed/,
      `Must not report a pass, got stdout: ${result.stdout}`);
    assert.doesNotMatch(result.stderr, /All mutants killed/,
      `Must not report a pass, got stderr: ${result.stderr}`);
  });

  it('--json mode also exits 1 (the fail-closed decision applies under --json too)', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '1', '--json'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 under --json, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /received no mutation budget/,
      `Expected the starvation reason in stderr under --json, got: ${result.stderr}`);
    // The JSON report (if printed) carries no verdict/"passed" field of its own
    // (see lib/report.mjs buildJsonReport) — the exit code alone is the
    // verdict, so a printed report is not a false-success document.
    if (result.stdout.trim() !== '') {
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.passed, undefined, 'JSON report must not claim a "passed" verdict');
      assert.equal(parsed.summary?.survived, 0, 'no mutant should have survived — this run never got that far for b/c');
    }
  });
});

// ── AC2: every selected file gets nonzero quota — unaffected, exits 0 ──────

describe('CLI: every diff-derived file gets quota — unaffected by the starvation guard', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-notstarved-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.mjs'), mathFile('add', '+'));
    writeFileSync(join(dir, 'test', 'a.test.mjs'), mathTest('add', 'a.mjs', 2, 3, 5));
    commitAll(dir, 'init');

    // Three files changed, all tested, --max sized (3) so each gets quota 1.
    // a.mjs gets a real content change (see the sibling describe block above
    // for why an identical rewrite would not count as a diff change).
    writeFileSync(join(dir, 'src', 'a.mjs'), mathFileTouched('add', '+'));
    writeFileSync(join(dir, 'src', 'b.mjs'), mathFile('sub', '-'));
    writeFileSync(join(dir, 'test', 'b.test.mjs'), mathTest('sub', 'b.mjs', 5, 3, 2));
    writeFileSync(join(dir, 'src', 'c.mjs'), mathFile('mul', '*'));
    writeFileSync(join(dir, 'test', 'c.test.mjs'), mathTest('mul', 'c.mjs', 2, 3, 6));
    commitAll(dir, 'add b.mjs and c.mjs, each with a test');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 — all-killed, exactly as before this fix', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '3'],
      dir
    );
    assert.equal(result.status, 0,
      `Expected exit 0 (no file starved), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /received no mutation budget/,
      `Must not report starvation when every file got quota, got: ${result.stderr}`);
  });
});

// ── AC3: a file with budget but no mutable lines still only warns ──────────

describe('CLI: a file with quota but no mutable lines is unaffected (still a warning, not fatal)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-nomutable-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.mjs'), mathFile('add', '+'));
    writeFileSync(join(dir, 'test', 'a.test.mjs'), mathTest('add', 'a.mjs', 2, 3, 5));
    commitAll(dir, 'init');

    // b.mjs changes but its body has nothing any mutation operator recognizes
    // (verified against packages/core/lib/mutate.mjs's operator list) — a
    // real "no mutable lines" case, distinct from starvation: with only 2
    // files and --max 5, b.mjs DOES receive nonzero quota. a.mjs gets a real
    // content change (a leading comment) so it also participates in the
    // diff and contributes at least one real, killed mutant — otherwise
    // results.length stays 0 and a DIFFERENT, already-existing check (#658,
    // "diff-derived file(s) produced zero mutants OVERALL") fires instead of
    // the one this test targets.
    writeFileSync(join(dir, 'src', 'a.mjs'), mathFileTouched('add', '+'));
    writeFileSync(join(dir, 'src', 'b.mjs'), [
      'export function announce() {',
      "  console.log('called');",
      '}',
      '',
    ].join('\n'));
    commitAll(dir, 'touch a.mjs, add unmutable b.mjs');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 and warns (not opError) about b.mjs having no mutable lines', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '5'],
      dir
    );
    assert.equal(result.status, 0,
      `Expected exit 0 (no-mutable-lines is non-fatal), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /no mutable lines/,
      `Expected the no-mutable-lines warning, got: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /received no mutation budget/,
      `Must not be classified as starved — it had budget, got: ${result.stderr}`);
  });
});
