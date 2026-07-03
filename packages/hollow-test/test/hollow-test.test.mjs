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
    // The untested file must actually be mutated and its survivors must be
    // visible — it must NOT vacuously exit 0.
    assert.notEqual(result.status, 0,
      `Explicit target with zero test coverage must not vacuously pass: ` +
      `status=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    if (result.status === 2) {
      const parsed = JSON.parse(result.stdout);
      assert.ok(
        parsed.mutants.some((m) => m.file === 'src/never_in_diff.mjs'),
        `Expected the explicit target to actually be mutated: ${result.stdout}`
      );
    }
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
