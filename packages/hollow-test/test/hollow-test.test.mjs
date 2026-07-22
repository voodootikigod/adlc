// hollow-test/test/hollow-test.test.mjs
// CLI integration tests. Uses mkdtempSync scratch git repos with real
// node:test test files. No network, no API keys.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// ── git helpers ──────────────────────────────────────────────────────────────

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

// ── scratch repo factories ───────────────────────────────────────────────────

/**
 * Strong test repo: real assertions on every function.
 * All mutants should be killed → CLI exits 0.
 */
function createStrongTestRepo(dir) {
  initRepo(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));

  writeFileSync(join(dir, 'src', 'math.mjs'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function isPositive(n) {',
    '  return n > 0;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'test', 'math.test.mjs'), [
    "import { describe, it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, isPositive } from '../src/math.mjs';",
    '',
    "describe('add', () => {",
    "  it('correct sum', () => {",
    '    assert.strictEqual(add(2, 3), 5);',
    '    assert.strictEqual(add(0, 0), 0);',
    '    assert.strictEqual(add(-1, 1), 0);',
    '  });',
    '});',
    "describe('isPositive', () => {",
    "  it('detects positive', () => {",
    '    assert.strictEqual(isPositive(1), true);',
    '    assert.strictEqual(isPositive(0), false);',
    '    assert.strictEqual(isPositive(-1), false);',
    '  });',
    '});',
    '',
  ].join('\n'));

  commitAll(dir, 'init');

  // Second commit adds multiply — shows up in HEAD~1 diff
  writeFileSync(join(dir, 'src', 'math.mjs'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function isPositive(n) {',
    '  return n > 0;',
    '}',
    '',
    'export function multiply(a, b) {',
    '  return a * b;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'test', 'math.test.mjs'), [
    "import { describe, it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, isPositive, multiply } from '../src/math.mjs';",
    '',
    "describe('add', () => {",
    "  it('correct sum', () => {",
    '    assert.strictEqual(add(2, 3), 5);',
    '    assert.strictEqual(add(0, 0), 0);',
    '    assert.strictEqual(add(-1, 1), 0);',
    '  });',
    '});',
    "describe('isPositive', () => {",
    "  it('detects positive', () => {",
    '    assert.strictEqual(isPositive(1), true);',
    '    assert.strictEqual(isPositive(0), false);',
    '    assert.strictEqual(isPositive(-1), false);',
    '  });',
    '});',
    "describe('multiply', () => {",
    "  it('correct product', () => {",
    '    assert.strictEqual(multiply(2, 3), 6);',
    '    assert.strictEqual(multiply(0, 5), 0);',
    '    assert.strictEqual(multiply(-2, 3), -6);',
    '  });',
    '});',
    '',
  ].join('\n'));

  commitAll(dir, 'add multiply');
  return dir;
}

/**
 * Weak test repo: assertion-free tests — any mutant survives.
 * CLI should exit 2.
 */
function createWeakTestRepo(dir) {
  initRepo(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));

  writeFileSync(join(dir, 'src', 'calc.mjs'), [
    'export function subtract(a, b) {',
    '  return a - b;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'test', 'calc.test.mjs'), [
    "import { describe, it } from 'node:test';",
    "import { subtract } from '../src/calc.mjs';",
    "describe('subtract', () => {",
    "  it('runs', () => { subtract(5, 3); });",
    '});',
    '',
  ].join('\n'));

  commitAll(dir, 'init');

  // Add divide with no-assertion test
  writeFileSync(join(dir, 'src', 'calc.mjs'), [
    'export function subtract(a, b) {',
    '  return a - b;',
    '}',
    '',
    'export function divide(a, b) {',
    '  return a / b;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'test', 'calc.test.mjs'), [
    "import { describe, it } from 'node:test';",
    "import { subtract, divide } from '../src/calc.mjs';",
    "describe('subtract', () => {",
    "  it('runs', () => { subtract(5, 3); });",
    '});',
    "describe('divide', () => {",
    "  it('runs', () => { divide(10, 2); });",
    '});',
    '',
  ].join('\n'));

  commitAll(dir, 'add divide');
  return dir;
}

/**
 * "rails-authoring" repo: commit 1 adds a real source file with NO tests;
 * commit 2 adds ONLY a test file for it (nothing in src/ changes). This is
 * exactly the diff shape of a P3 characterization/rails-authoring ticket
 * (issues #70 / #41 / #35B) — `git diff HEAD~1` contains a single new test
 * file and nothing mutable.
 */
function createRailsAuthoringRepo(dir) {
  initRepo(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));

  writeFileSync(join(dir, 'src', 'guarded.mjs'), [
    'export function isPositive(n) {',
    '  return n > 0;',
    '}',
    '',
  ].join('\n'));

  commitAll(dir, 'init: add guarded.mjs, no tests yet');

  // Second commit adds ONLY a test file — src/guarded.mjs does not change.
  writeFileSync(join(dir, 'test', 'guarded.test.mjs'), [
    "import { describe, it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { isPositive } from '../src/guarded.mjs';",
    "describe('isPositive', () => {",
    "  it('detects positive, zero, and negative', () => {",
    '    assert.strictEqual(isPositive(1), true);',
    '    assert.strictEqual(isPositive(0), false);',
    '    assert.strictEqual(isPositive(-1), false);',
    '  });',
    '});',
    '',
  ].join('\n'));

  commitAll(dir, 'add rails for guarded.mjs (test-only diff)');
  return dir;
}

/**
 * "overlap" repo: commit 1 adds a file containing an UNTESTED function;
 * commit 2 adds a second, well-tested function to the SAME file without
 * touching the untested function's lines. `git diff HEAD~1` therefore
 * includes this file, but only the well-tested function's lines are
 * diff-changed — the untested function sits outside the diff.
 *
 * This is the fixture for AC2 (docs/specs/hollow-test-target-mode.md):
 * --target on a file that ALSO appears in the diff must drop the
 * diff-line restriction and mutate the WHOLE file, reaching the untested
 * function too — not just silently keep the diff-scoped subset.
 */
function createOverlapRepo(dir) {
  initRepo(dir);
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'test'));

  writeFileSync(join(dir, 'src', 'overlap.mjs'), [
    'export function untested(n) {',
    '  return n < 0;',
    '}',
    '',
  ].join('\n'));

  commitAll(dir, 'init: add overlap.mjs with an untested function');

  // Second commit adds `tested` to the SAME file — real coverage — without
  // touching `untested`'s lines above (lines 1-3 are unchanged).
  writeFileSync(join(dir, 'src', 'overlap.mjs'), [
    'export function untested(n) {',
    '  return n < 0;',
    '}',
    '',
    'export function tested(n) {',
    '  return n > 0;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(dir, 'test', 'overlap.test.mjs'), [
    "import { describe, it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { tested } from '../src/overlap.mjs';",
    "describe('tested', () => {",
    "  it('detects positive, zero, and negative', () => {",
    '    assert.strictEqual(tested(1), true);',
    '    assert.strictEqual(tested(0), false);',
    '    assert.strictEqual(tested(-1), false);',
    '  });',
    '});',
    '',
  ].join('\n'));

  commitAll(dir, 'add tested() with real coverage; untested() left unchanged');
  return dir;
}

// ── CLI runner ───────────────────────────────────────────────────────────────

const BIN = resolve(new URL('.', import.meta.url).pathname, '../bin/hollow-test.mjs');

function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60000,
  });
}

// ── strong-test scenario ─────────────────────────────────────────────────────

describe('CLI: strong tests (all mutants killed)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-strong-'));
    createStrongTestRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 when all mutants are killed', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10', '--json'],
      dir
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, `stdout is not valid JSON: ${result.stdout}`);
    assert.ok(parsed.summary.total > 0,
      `Expected at least one mutant to be generated and tested (total=${parsed.summary.total}) — ` +
      'this catches a gutted mutation engine that produces zero mutants');
    assert.equal(parsed.summary.survived, 0,
      `Expected zero survivors but got ${parsed.summary.survived}`);
  });

  it('files are byte-identical after run (restoration proof)', () => {
    const srcPath = join(dir, 'src', 'math.mjs');
    const before = readFileSync(srcPath, 'utf8');
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10', '--json'],
      dir
    );
    // Verify the engine actually ran mutants — otherwise byte-identity is trivially true.
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, `stdout is not valid JSON: ${result.stdout}`);
    assert.ok(parsed.summary.total > 0,
      `Expected at least one mutant to be generated (total=${parsed.summary.total}) — ` +
      'restoration proof is meaningless if no file was ever mutated');
    const after = readFileSync(srcPath, 'utf8');
    assert.equal(after, before, 'File content was not restored after mutation run');
  });

  it('--json flag outputs valid JSON with correct shape', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '5', '--json'],
      dir
    );
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(result.stdout);
    }, `stdout is not valid JSON: ${result.stdout}`);
    assert.ok('summary' in parsed, 'missing summary');
    assert.ok('mutants' in parsed, 'missing mutants');
    assert.ok(typeof parsed.summary.total === 'number', 'total is not a number');
    assert.ok(parsed.summary.total > 0,
      `Expected at least one mutant to be generated (total=${parsed.summary.total}) — ` +
      'a gutted engine that produces zero mutants must not satisfy this check');
    assert.equal(parsed.summary.survived, 0);
  });
});

// ── weak-test scenario ───────────────────────────────────────────────────────

describe('CLI: weak tests (survivors detected)', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-weak-'));
    createWeakTestRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 2 when mutants survive', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10'],
      dir
    );
    assert.equal(result.status, 2,
      `Expected exit 2, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });

  it('files are byte-identical after run (restoration proof)', () => {
    const srcPath = join(dir, 'src', 'calc.mjs');
    const before = readFileSync(srcPath, 'utf8');
    runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10'],
      dir
    );
    const after = readFileSync(srcPath, 'utf8');
    assert.equal(after, before, 'File content was not restored after weak-test mutation run');
  });

  it('reports survived mutants in JSON output', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10', '--json'],
      dir
    );
    assert.equal(result.status, 2);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); });
    assert.ok(parsed.summary.survived > 0, 'Expected at least one survivor in JSON');
  });
});

// ── dirty tree rejection ─────────────────────────────────────────────────────

describe('CLI: dirty tree rejection', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-dirty-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 1;\n');
    git(['add', '-A'], dir);
    git(['commit', '-m', 'init'], dir);
    writeFileSync(join(dir, 'src', 'x.mjs'), 'export const x = 2;\n'); // dirty
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 with dirty tree', () => {
    const result = runCli(['--test-cmd', 'node --test', '--base', 'HEAD'], dir);
    assert.equal(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('commit or stash first'),
      `Expected 'commit or stash first' in stderr, got: ${result.stderr}`
    );
  });
});

// ── red baseline rejection (the exploit) ──────────────────────────────────────
// If the baseline (unmutated) suite is red, the runner marks EVERY mutant
// "killed" (test exits non-zero regardless of the mutation) → vacuous pass.
// The gate must run the unmutated suite once first and refuse if it isn't green.

describe('CLI: red baseline rejection', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-redbase-'));
    // A normal strong repo gives us a real diff with mutable targets.
    createStrongTestRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 (baseline not green), NOT 0, when --test-cmd is always-failing', () => {
    // The exploit: a test command that always exits non-zero. Without a green
    // baseline check, the runner sees every mutant as "killed" and exits 0
    // ("All mutants killed"). The fix must catch this and exit 1.
    const result = runCli(
      ['--test-cmd', 'node -e "process.exit(1)"', '--base', 'HEAD~1', '--max', '10'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 (red baseline refused), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('baseline suite is not green'),
      `Expected 'baseline suite is not green' in stderr, got: ${result.stderr}`
    );
  });

  it('does not falsely report "All mutants killed" on a red baseline', () => {
    const result = runCli(
      ['--test-cmd', 'false', '--base', 'HEAD~1', '--max', '10'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1, got ${result.status}\nstderr: ${result.stderr}`);
    assert.ok(
      !result.stdout.includes('All mutants killed'),
      `Gate vacuously passed on a red baseline: ${result.stdout}`
    );
  });
});

// ── default-base fail-closed ───────────────────────────────────────────────────
// With no --base and no main/master trunk to resolve a merge-base against,
// the old default ('HEAD') diffed HEAD vs HEAD = empty = vacuous pass. The fix
// resolves a trunk merge-base and fails closed (exit 1) when none exists.

describe('CLI: default base fails closed', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-nobase-'));
    initRepo(dir);
    // Rename the only branch off any trunk candidate so resolveBase() → null.
    git(['branch', '-m', 'main', 'feature-only'], dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'math.mjs'), [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'test', 'math.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.mjs';",
      "describe('add', () => {",
      "  it('sums', () => { assert.strictEqual(add(2, 3), 5); });",
      '});',
      '',
    ].join('\n'));
    commitAll(dir, 'init');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 when no --base and no trunk to resolve a base from', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 (no resolvable base), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('could not resolve a base ref'),
      `Expected 'could not resolve a base ref' in stderr, got: ${result.stderr}`
    );
  });
});

// ── test-only diff: exit 1 with no --target/--rails (issues #70/#41/#35B) ───

describe('CLI: test-only diff has nothing to mutate', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-railsonly-'));
    createRailsAuthoringRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 (operational error), NOT 0, when the diff contains only test files', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 (nothing to mutate), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      /nothing to mutate|no eligible/i.test(result.stderr),
      `Expected an explanatory "nothing to mutate" error, got stderr: ${result.stderr}`
    );
  });

  it('does not silently report a vacuous 0/0/0 JSON pass on a test-only diff', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10', '--json'],
      dir
    );
    assert.notEqual(result.status, 0,
      `A test-only diff must not exit 0 — this is the exact bug reported in #70: ` +
      `stdout: ${result.stdout}`);
  });
});

// ── explicit targets must respect the source allow-list ────────────────────
//
// The allow-list was applied only to DIFF-derived files; --target and --rails
// paths were unioned into the mutation set unchecked. So a caller could point
// JS-shaped operators at a .py or .css file, and the result is not merely
// useless — it is actively misleading. runner.mjs scores
// `killed = timedOut || status !== 0`, so a mutant that renders the file
// syntactically invalid makes the test command fail and is recorded as KILLED.
// A characterization ticket naming src/app.py would report every mutant killed
// without ever proving a behavioural assertion: a false green on the gate whose
// entire purpose is detecting false greens.
//
// Refusing loudly is the fail-closed behaviour this CLI already uses elsewhere
// (see the --max starvation check): the caller named the file deliberately, so
// silently dropping it would be its own silent-green bug.

describe('CLI: an explicit --target outside the source allow-list is refused', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-badtarget-'));
    createRailsAuthoringRepo(dir);
    writeFileSync(join(dir, 'src', 'app.py'), 'def f():\n    return 1\n');
    writeFileSync(join(dir, 'src', 'style.css'), '.a { opacity: 0; }\n');
    // Committed: hollow-test refuses to run on a dirty tree (it mutates in
    // place and restores), so leaving these uncommitted would fail the run for
    // an unrelated reason and mask what this case is actually asserting.
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'add unsupported-language fixtures'], dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const target of ['src/app.py', 'src/style.css']) {
    it(`refuses --target ${target} instead of mutating it`, () => {
      const result = runCli(
        ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1',
         '--target', target, '--max', '10'],
        dir
      );
      // Assert the SPECIFIC refusal, not merely "non-zero and mentions the
      // file". Without the guard hollow-test happily mutates the .py, every
      // mutant survives, and it exits 2 with the filename in the report — so a
      // looser assertion passes for entirely the wrong reason. (Caught by
      // mutating the guard away: the first version of this test stayed green.)
      const out = result.stderr + result.stdout;
      assert.match(out, /not a supported source language/,
        `Expected the unsupported-target refusal, got: ${out}`);
      assert.match(out, new RegExp(target.replace('.', '\\.')),
        'the refusal must name the offending target');
      assert.equal(result.status, 1,
        `Expected exit 1 (operational refusal), not a gate failure — got ${result.status}: ${out}`);
      assert.doesNotMatch(out, /SURVIVED|KILLED/,
        'the run must refuse before generating any mutant');
    });
  }
});

// The language guard must NOT re-import test-path exclusion. Explicit targets
// deliberately bypass it — rails ARE test files, which is the entire point of
// the P3 rails-authoring workflow. An earlier revision of this guard used the
// combined predicate and rejected every rail under a test/ directory, breaking
// the documented contract while looking like a safety improvement.
describe('CLI: explicit targets still bypass test-path exclusion', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-testtarget-'));
    createRailsAuthoringRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mutates a --target under test/ rather than refusing it', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1',
       '--target', 'test/guarded.test.mjs', '--max', '3', '--json'],
      dir
    );
    const out = result.stderr + result.stdout;
    assert.doesNotMatch(out, /not a supported source language/,
      `a test-path target must not be rejected by the language guard: ${out}`);
    assert.notEqual(result.status, 1,
      `expected the run to proceed, not an operational refusal: ${out}`);
  });
});

// A rails glob legitimately matches non-source: schemas/**, JSON, fixtures.
// Those are filtered from the mutation set — but an earlier revision still fed
// the ORIGINAL rail list to the post-run zero-mutant verifier, so a mixed
// expansion did all the mutation work and THEN failed, claiming the JSON file
// produced no mutants. Filtering something out and then demanding results for it
// is the kind of bug that only shows up on a real mixed ticket.
describe('CLI: --rails matching a mix of source and non-source', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-mixedrails-'));
    createRailsAuthoringRepo(dir);
    writeFileSync(join(dir, 'schema.json'), '{"a":1}\n');
    writeFileSync(join(dir, 'ticket.json'), JSON.stringify({
      id: 'T1', rails: ['src/guarded.mjs', 'schema.json'],
    }));
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'mixed rails fixture'], dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mutates the source rail and does not fail over the dropped JSON', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1',
       '--rails', 'ticket.json', '--max', '10', '--json'],
      dir
    );
    const out = result.stderr + result.stdout;
    assert.notEqual(result.status, 1,
      `expected the run to complete, not an operational failure: ${out}`);
    assert.match(result.stderr, /schema\.json/,
      'the dropped non-source rail must be reported, not silently ignored');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); },
      `stdout is not valid JSON: ${result.stdout}`);
    assert.ok(parsed.mutants.every((m) => m.file === 'src/guarded.mjs'),
      'only the supported rail should be mutated');
  });
});

// --test-glob end to end, the mirror of --source-glob below. Same two-glob
// reasoning: the flag is `multiple: true`, and with `multiple: false` parseArgs
// hands back a bare string whose `.some` does not exist, so the option would
// throw the moment anyone used it. Asserting the specific "nothing to mutate"
// refusal (rather than merely a non-zero exit) is what distinguishes the option
// WORKING from the option CRASHING — both are non-zero.
describe('CLI: --test-glob reclassifies a source file as a test', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-testglob-'));
    createRailsAuthoringRepo(dir);
    writeFileSync(join(dir, 'src', 'alpha.mjs'), 'export const a = (x) => x > 0;\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'add alpha'], dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mutates the file normally without the declaration', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1',
       '--max', '3', '--json'],
      dir
    );
    assert.doesNotMatch(result.stderr, /nothing to mutate/,
      `expected alpha.mjs to be mutable by default: ${result.stderr}`);
  });

  it('refuses to mutate it once declared a test', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1',
       '--test-glob', '**/nothing-matches-this.mjs',
       '--test-glob', '**/alpha.mjs',
       '--max', '3'],
      dir
    );
    const out = result.stderr + result.stdout;
    assert.match(out, /nothing to mutate/,
      `expected the declared test file to leave nothing mutable: ${out}`);
    assert.doesNotMatch(out, /TypeError/,
      'a crash is not the same as the option working');
  });
});

// --source-glob end to end, through DIFF-DERIVED selection.
//
// The first version of this test passed --target for both halves, which made it
// hollow: explicit targets deliberately bypass test-path classification and
// enter the mutation set on extension alone, so both assertions stayed green
// whether or not sourceGlobs ever reached filterTargetFiles. A refactor dropping
// that forwarding — the exact regression this test exists to catch — would not
// have failed it.
//
// No --target here. The file arrives through the diff, so the ONLY thing that
// can make it mutable is the declaration.
//
// Two globs deliberately: the flag is `multiple: true`, and with
// `multiple: false` parseArgs returns a bare string whose `.some` does not
// exist. And the negative half asserts the SPECIFIC "nothing to mutate"
// refusal — the option working and the option crashing are both non-zero, and
// only the message distinguishes them.
describe('CLI: --source-glob rescues a diff-derived file named like a test', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-sourceglob-'));
    createRailsAuthoringRepo(dir);
    // Sole content of the final commit, so `--base HEAD~1` yields a diff whose
    // only candidate is this file — nothing else can keep the run alive.
    writeFileSync(join(dir, 'src', 'widget-test.mjs'),
      'export const ok = (x) => x > 0;\n');
    git(['add', '-A'], dir);
    git(['commit', '-qm', 'add hyphen-named production file'], dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is excluded by naming convention without the declaration', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '3'],
      dir
    );
    const out = result.stderr + result.stdout;
    assert.match(out, /nothing to mutate/,
      `a node --test-shaped name must not be mutated by default: ${out}`);
  });

  it('becomes diff-derived mutable source once declared', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1',
       '--source-glob', '**/nothing-matches-this.mjs',
       '--source-glob', '**/widget-test.mjs',
       '--max', '3', '--json'],
      dir
    );
    const out = result.stderr + result.stdout;
    assert.doesNotMatch(out, /nothing to mutate/,
      `the declaration must make it eligible through diff selection: ${out}`);
    assert.doesNotMatch(out, /TypeError/,
      'a crash is not the same as the option working');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); },
      `stdout is not valid JSON: ${out}`);
    assert.ok(parsed.mutants.some((m) => m.file === 'src/widget-test.mjs'),
      'the declared file must actually be mutated');
  });
});

// ── --target / --rails: mutate declared targets outside the diff (#70/#41) ──

describe('CLI: --target mutates a file outside the diff', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-target-'));
    createRailsAuthoringRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('mutates src/guarded.mjs (unchanged in the diff) and the rails kill it', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', 'src/guarded.mjs',
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 0,
      `Expected exit 0 (rails kill every mutant), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, `stdout is not valid JSON: ${result.stdout}`);
    assert.ok(parsed.summary.total > 0,
      `Expected --target to generate mutants for a file outside the diff (total=${parsed.summary.total})`);
    assert.ok(parsed.mutants.every((m) => m.file === 'src/guarded.mjs'),
      'expected all mutants to target the explicitly given file');
    assert.equal(parsed.summary.survived, 0, 'expected the real rails to kill every mutant');
  });

  it('restores src/guarded.mjs byte-identical after mutating a non-diff target', () => {
    const srcPath = join(dir, 'src', 'guarded.mjs');
    const before = readFileSync(srcPath, 'utf8');
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', 'src/guarded.mjs',
        '--max', '10',
        '--json',
      ],
      dir
    );
    // Verify --target actually ran (exit 0 + mutants generated) — otherwise
    // this test would trivially pass if --target were reverted/unrecognized,
    // since parseArgs would error out before ever touching the file.
    assert.equal(result.status, 0,
      `Expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, `stdout is not valid JSON: ${result.stdout}`);
    assert.ok(parsed.summary.total > 0,
      `Expected --target to actually generate mutants for src/guarded.mjs (total=${parsed.summary.total}) — ` +
      'restoration proof is meaningless if the file was never mutated');
    const after = readFileSync(srcPath, 'utf8');
    assert.equal(after, before, 'File content was not restored after --target mutation run');
  });
});

// ── --target/--rails fail-closed edge cases (review round 1) ───────────────

describe('CLI: --target with a nonexistent file fails closed', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-target-missing-'));
    createRailsAuthoringRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 (NOT 0) with a clear error, not a vacuous 0/0/0 JSON pass', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', 'src/does_not_exist.mjs',
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 1,
      `A missing --target file must fail closed, not silently pass: ` +
      `status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      /not found or unreadable/i.test(result.stderr),
      `Expected an explanatory "not found or unreadable" error, got stderr: ${result.stderr}`
    );
    // Nothing resembling a passing JSON summary should reach stdout.
    assert.ok(
      !/"summary"/.test(result.stdout),
      `Expected no JSON summary on a fail-closed error, got stdout: ${result.stdout}`
    );
  });
});

describe('CLI: --target pointing at a file with no mutable content fails closed', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-target-decoy-'));
    createRailsAuthoringRepo(dir);
    // A decoy file with zero mutable lines — the critical-severity repro:
    // an explicit target that exists and is readable but can never generate
    // a mutant must not be treated the same as "all mutants killed".
    writeFileSync(join(dir, 'src', 'decoy.mjs'), [
      '// nothing to see here',
      'export {}',
      '',
    ].join('\n'));
    git(['add', '-A'], dir);
    git(['commit', '-m', 'add decoy file'], dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 (NOT 0) instead of falling through to the empty-results pass', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', 'src/decoy.mjs',
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 1,
      `An explicit target with zero mutable content must fail closed, not silently pass: ` +
      `status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      /produced zero mutants/i.test(result.stderr),
      `Expected an explanatory "produced zero mutants" error, got stderr: ${result.stderr}`
    );
  });
});

describe('CLI: --max budget cannot silently starve an explicit --target', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-target-budget-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));

    // Commit 1: the explicit target, with ZERO test coverage — never
    // referenced by any test — committed FIRST so it is outside the diff.
    writeFileSync(join(dir, 'src', 'never_in_diff.mjs'), [
      'export function neverTested(n) {',
      '  return n > 0;',
      '}',
      '',
    ].join('\n'));
    commitAll(dir, 'init: untested file, outside the future diff');

    // Commit 2: 3 diff-eligible files, each with a real, killing test —
    // these show up in `git diff HEAD~1`.
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(dir, 'src', `${name}.mjs`), [
        `export function ${name}(n) {`,
        '  return n > 0;',
        '}',
        '',
      ].join('\n'));
    }
    writeFileSync(join(dir, 'test', 'diff.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { one } from '../src/one.mjs';",
      "import { two } from '../src/two.mjs';",
      "import { three } from '../src/three.mjs';",
      "describe('diff files', () => {",
      "  it('kill every mutant', () => {",
      '    assert.strictEqual(one(1), true);',
      '    assert.strictEqual(one(-1), false);',
      '    assert.strictEqual(two(1), true);',
      '    assert.strictEqual(two(-1), false);',
      '    assert.strictEqual(three(1), true);',
      '    assert.strictEqual(three(-1), false);',
      '  });',
      '});',
      '',
    ].join('\n'));

    commitAll(dir, 'add three diff files (tested)');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reserves budget for the explicit target instead of silently zeroing its quota', () => {
    // --max equals the number of diff-eligible files: under the old
    // round-robin-by-index allocation, the explicit target got quota 0 and
    // this printed a false "all mutants killed" 0-survivor pass.
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', 'src/never_in_diff.mjs',
        '--max', '3',
        '--json',
      ],
      dir
    );
    // This must land on exit 2 (a real mutation run found a survivor),
    // NOT exit 1 (the pre-existing starvedByBudget operational-refusal
    // guard in bin/hollow-test.mjs). A plain `notEqual(result.status, 0)`
    // here would also be satisfied by status 1 if the priorityFiles
    // reservation in buildFileTargets() were deleted entirely — starvedByBudget
    // would still catch the resulting quota-0 explicit target and refuse to
    // run, making this test pass for the wrong reason and leaving the
    // reservation mechanism itself unpinned at the CLI level. Asserting
    // status === 2 unconditionally (with the same fail-closed reasoning
    // this PR (#70/#41/#35) exists to enforce) forces the reservation to
    // have actually granted the target a mutable quota.
    assert.equal(result.status, 2,
      `Explicit target with zero test coverage must be mutated by a real run ` +
      `(status 2), not silently pass (0) or be blocked by the operational ` +
      `starved-budget guard (1): status=${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.mutants.some((m) => m.file === 'src/never_in_diff.mjs'),
      `Expected the explicit target to actually be mutated: ${result.stdout}`
    );
  });
});

describe('CLI: --rails reads declared rail globs from a ticket file', () => {
  let dir;
  let ticketPath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-rails-flag-'));
    createRailsAuthoringRepo(dir);
    // Kept OUTSIDE the repo (a separate tmp dir) — the ticket file is metadata
    // about the build, not a tracked repo file; writing it inside `dir` would
    // dirty the working tree and trip the dirty-tree guard.
    const ticketDir = mkdtempSync(join(tmpdir(), 'hollow-ticket-'));
    ticketPath = join(ticketDir, 'ticket.json');
    writeFileSync(ticketPath, JSON.stringify({
      tickets: [{ id: 'T1', title: 'characterize guarded.mjs', rails: ['src/guarded.mjs'] }],
    }));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('expands the ticket-declared rails glob to a mutation target and passes', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--rails', ticketPath,
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 0,
      `Expected exit 0, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); });
    assert.ok(parsed.summary.total > 0,
      `Expected --rails to expand to a mutable file (total=${parsed.summary.total})`);
    assert.ok(parsed.mutants.every((m) => m.file === 'src/guarded.mjs'));
  });
});

// ── --rails glob matching must survive a non-root cwd (review round 5) ─────
// `git ls-files` (unlike `git diff`) returns paths relative to the CURRENT
// WORKING DIRECTORY it is invoked from, not the repo root. Rails globs are
// authored repo-root-relative in ticket files, so running hollow-test from
// a subdirectory (e.g. a per-package script that `cd`s into pkgs/sub first)
// must still match — this pins the --full-name fix against regression.

describe('CLI: --rails matches correctly when invoked from a non-root cwd', () => {
  let dir;
  let subDir;
  let ticketPath;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-rails-subdir-'));
    initRepo(dir);
    subDir = join(dir, 'pkgs', 'sub');
    mkdirSync(join(subDir, 'src'), { recursive: true });
    mkdirSync(join(subDir, 'test'), { recursive: true });

    writeFileSync(join(subDir, 'src', 'guarded.mjs'), [
      'export function isPositive(n) {',
      '  return n > 0;',
      '}',
      '',
    ].join('\n'));
    commitAll(dir, 'init: add nested guarded.mjs, no tests yet');

    // Second commit adds ONLY a test file — src/guarded.mjs does not change,
    // producing a test-only diff (the P3 rails-authoring shape).
    writeFileSync(join(subDir, 'test', 'guarded.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { isPositive } from '../src/guarded.mjs';",
      "describe('isPositive', () => {",
      "  it('detects positive, zero, and negative', () => {",
      '    assert.strictEqual(isPositive(1), true);',
      '    assert.strictEqual(isPositive(0), false);',
      '    assert.strictEqual(isPositive(-1), false);',
      '  });',
      '});',
      '',
    ].join('\n'));
    commitAll(dir, 'add rails for nested guarded.mjs (test-only diff)');

    const ticketDir = mkdtempSync(join(tmpdir(), 'hollow-ticket-subdir-'));
    ticketPath = join(ticketDir, 'ticket.json');
    writeFileSync(ticketPath, JSON.stringify({
      tickets: [{
        id: 'T1',
        title: 'characterize nested guarded.mjs',
        rails: ['pkgs/sub/src/guarded.mjs'],
      }],
    }));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('expands a repo-root-relative rails glob even when cwd is a subdirectory of the repo', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--rails', ticketPath,
        '--max', '10',
        '--json',
      ],
      subDir, // cwd is a subdirectory, NOT the repo root
    );
    assert.equal(result.status, 0,
      `Expected exit 0 when hollow-test is invoked from a subdirectory, got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}\n` +
      'A "declared globs matched no tracked files" error here means `git ls-files` ' +
      'regressed back to returning cwd-relative paths.');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); }, `stdout is not valid JSON: ${result.stdout}`);
    assert.ok(parsed.summary.total > 0,
      `Expected --rails to expand to a mutable file from a subdirectory cwd (total=${parsed.summary.total})`);
    assert.ok(parsed.mutants.every((m) => m.file === 'pkgs/sub/src/guarded.mjs'),
      `Expected mutant file paths to stay repo-root-relative: ${JSON.stringify(parsed.mutants)}`);
    assert.equal(parsed.summary.survived, 0, 'expected the real rails to kill every mutant');
  });
});

// ── --target must not escape the repository root (review round 5) ─────────
// Unlike --rails (whose globs can only ever match `git ls-files` output, so
// they structurally can't escape the repo), --target is a literal caller-typed
// path with no containment check of its own. A path like `--target
// ../../../etc/passwd` must be rejected, not resolved-and-read.

describe('CLI: --target rejects a path that escapes the repo root', () => {
  let dir;
  let outsideFile;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-target-escape-'));
    createRailsAuthoringRepo(dir);
    // A file that exists on disk OUTSIDE the repo, so a successful escape
    // would be readable (proving the containment check, not a coincidental
    // ENOENT) if it were not rejected first.
    outsideFile = join(dir, '..', 'outside-secret.mjs');
    writeFileSync(outsideFile, 'export const secret = 1;\n');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideFile, { force: true });
  });

  it('exits 1 (NOT 0) for a relative --target that resolves above the repo root', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', '../outside-secret.mjs',
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 1,
      `A --target path escaping the repo root must fail closed: ` +
      `status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      /resolves outside the repository root/i.test(result.stderr),
      `Expected an explanatory containment error, got stderr: ${result.stderr}`
    );
    assert.ok(
      !/"summary"/.test(result.stdout),
      `Expected no JSON summary on a fail-closed containment error, got stdout: ${result.stdout}`
    );
  });

  it('exits 1 (NOT 0) for an absolute --target path outside the repo', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', outsideFile,
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 1,
      `An absolute --target path outside the repo must fail closed: ` +
      `status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      /resolves outside the repository root/i.test(result.stderr),
      `Expected an explanatory containment error, got stderr: ${result.stderr}`
    );
  });
});

// ── --target/--rails must not escape the repo root via a symlink ───────────
// escapesRoot() (used by both --target and, as of this fix, --rails) is a
// purely LEXICAL check — path.resolve()/path.relative() never dereference
// symlinks. A symlink that lives INSIDE the repo but points OUTSIDE it
// resolves (textually) to a path under the repo root and would sail through
// that check, while every actual filesystem read/write against that path
// (readFileSafe, the mutation loop's writeFileSync) is done by the OS, which
// DOES follow the symlink straight through to wherever it points. This is a
// real containment bypass (confirmed by direct reproduction against the
// pre-fix binary: an unmutated outside file was read, mutated, tested, and
// restored, entirely outside the "resolves inside the repository root"
// guarantee promised by --help), not just a theoretical one. Pin the
// symlink-aware real-path check for both entry points.

describe('CLI: --target/--rails reject a symlink that escapes the repo root', () => {
  let dir;
  let outsideDir;
  let outsideFile;
  let ticketPath;

  const outsideContent = [
    'export function check(a, b) {',
    '  if (a > b) {',
    '    return true;',
    '  }',
    '  return false;',
    '}',
    '',
  ].join('\n');

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-target-symlink-'));
    createRailsAuthoringRepo(dir);

    // A real, mutable file OUTSIDE the repo entirely (a separate temp dir,
    // not just above `dir`) — content chosen so a successful escape would
    // actually generate and apply mutants, proving read+mutate rather than a
    // coincidental ENOENT or a comment-only false negative.
    outsideDir = mkdtempSync(join(tmpdir(), 'hollow-outside-'));
    outsideFile = join(outsideDir, 'secret.mjs');
    writeFileSync(outsideFile, outsideContent);

    // A symlink INSIDE the repo pointing at the outside directory — the
    // vector for --target, which resolves an arbitrary caller-typed path on
    // the filesystem directly (`escape-link/secret.mjs` walks through the
    // symlinked directory to the file beyond it). It must be committed (not
    // merely present) — hollow-test refuses to run on a dirty tree, so an
    // untracked symlink alone would fail via the dirty-tree guard before
    // ever reaching the containment check this test targets.
    symlinkSync(outsideDir, join(dir, 'escape-link'));

    // A second symlink, this one a direct file->file link tracked at its OWN
    // path — the vector for --rails: `git ls-files` lists a tracked symlink
    // as a single leaf entry (it does not traverse "through" a symlink the
    // way a real directory would), so a rails glob can only ever match the
    // symlink's own tracked name, never a path "inside" it. Naming that
    // tracked symlink directly is the realistic rails-side escape.
    symlinkSync(outsideFile, join(dir, 'escape-link-file.mjs'));
    commitAll(dir, 'add symlinks pointing outside the repo');

    const ticketDir = mkdtempSync(join(tmpdir(), 'hollow-symlink-ticket-'));
    ticketPath = join(ticketDir, 'ticket.json');
    writeFileSync(ticketPath, JSON.stringify({
      tickets: [{
        id: 'T1',
        title: 'symlink escape via rails',
        rails: ['escape-link-file.mjs'],
      }],
    }));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('exits 1 (NOT 0) for a --target path through a symlink that escapes the repo root', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', 'escape-link/secret.mjs',
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 1,
      `A --target path through a symlink escaping the repo root must fail closed: ` +
      `status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      /escapes it via a symlink/i.test(result.stderr),
      `Expected a symlink-aware containment error, got stderr: ${result.stderr}`
    );
    assert.ok(
      !/"summary"/.test(result.stdout),
      `Expected no JSON summary on a fail-closed containment error, got stdout: ${result.stdout}`
    );
    // The outside file must be untouched — no mutation was ever applied to it.
    assert.equal(
      readFileSync(outsideFile, 'utf8'),
      outsideContent,
      'The file outside the repo must not have been read or mutated'
    );
  });

  it('exits 1 (NOT 0) for a --rails glob matching a symlink that escapes the repo root', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--rails', ticketPath,
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 1,
      `A --rails glob matching a symlink escaping the repo root must fail closed: ` +
      `status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(
      /escapes it via a symlink/i.test(result.stderr),
      `Expected a symlink-aware containment error, got stderr: ${result.stderr}`
    );
    assert.ok(
      !/"summary"/.test(result.stdout),
      `Expected no JSON summary on a fail-closed containment error, got stdout: ${result.stdout}`
    );
    assert.equal(
      readFileSync(outsideFile, 'utf8'),
      outsideContent,
      'The file outside the repo must not have been read or mutated'
    );
  });
});

// ── --target overrides diff-line restriction on an overlapping file (AC2) ──
// docs/specs/hollow-test-target-mode.md AC2 documents that --target mutates
// the whole file "even if the file also happens to appear in the diff" —
// implemented by `delete effectiveChangedLines[f]` in hollow-test.mjs. No
// prior test exercised the overlap case (a file that is both diff-eligible
// AND passed via --target); this pins that behavior against regression.

describe('CLI: --target on a file that also appears in the diff mutates the whole file', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-target-overlap-'));
    createOverlapRepo(dir);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('diff-only run (no --target): untested() sits outside the diff-changed lines and is never mutated', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--max', '10', '--json'],
      dir
    );
    assert.equal(result.status, 0,
      `Expected exit 0 (only diff-changed, well-tested tested() lines mutated), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); });
    assert.ok(parsed.summary.total > 0, 'Expected the diff-scoped run to still generate some mutants');
    assert.ok(
      parsed.mutants.every((m) => m.line > 3),
      `Expected diff-scoped mutants to stay off untested()'s lines (1-3): ${JSON.stringify(parsed.mutants)}`
    );
  });

  it('--target on the same file drops the diff-line restriction and reaches untested(), producing a survivor', () => {
    const result = runCli(
      [
        '--test-cmd', 'node --test test/*.test.mjs',
        '--base', 'HEAD~1',
        '--target', 'src/overlap.mjs',
        '--max', '10',
        '--json',
      ],
      dir
    );
    assert.equal(result.status, 2,
      `Expected exit 2 (--target's whole-file mutation reaches untested() outside the diff), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.stdout); });
    assert.ok(
      parsed.mutants.some((m) => m.line <= 3),
      `Expected --target to override the diff-line restriction and mutate untested()'s lines (1-3): ${JSON.stringify(parsed.mutants)}`
    );
    assert.ok(parsed.summary.survived > 0, 'Expected the untested() mutant to survive uncaught');
  });
});

// ── no-args / help ───────────────────────────────────────────────────────────

describe('CLI: no-args and --help', () => {
  it('exits 1 and shows usage when --test-cmd is missing', () => {
    const result = runCli([], process.cwd());
    assert.equal(result.status, 1,
      `Expected exit 1 (missing --test-cmd), got ${result.status}`);
  });

  it('exits 0 and shows help with --help flag', () => {
    const result = runCli(['--help'], process.cwd());
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('hollow-test'));
    assert.ok(result.stdout.includes('--test-cmd'));
  });
});
