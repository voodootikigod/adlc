// Integration-level tests for runChecks() — uses real git repos in temp dirs.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runChecks } from '../lib/check.mjs';

// ---- helpers ----------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'rails-guard-test-'));
  git(['init', '-b', 'main'], dir);
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

function getChangedFiles(dir, base) {
  return execFileSync('git', ['diff', '--name-only', base, '--'], { cwd: dir, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

function getDiff(dir, base) {
  return execFileSync('git', ['diff', base, '--'], { cwd: dir, encoding: 'utf8' });
}

// ---- tests ------------------------------------------------------------------

describe('runChecks — rail-edit detection', () => {
  let dir;

  before(() => {
    dir = setupRepo();
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => {});\n');
    writeFile(dir, 'src/auth.ts', 'export function login() {}\n');
    commit(dir, 'initial');
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('no violation when source file changes (not a rail)', () => {
    writeFile(dir, 'src/auth.ts', 'export function login() { return true; }\n');
    const files = getChangedFiles(dir, 'HEAD');
    const diff  = getDiff(dir, 'HEAD');
    const result = runChecks({ changedFiles: files, diffText: diff, cliRails: ['test/**'], ticket: null });
    assert.equal(result.violations.filter(v => v.type === 'rail-edit').length, 0);
    assert.ok(result.railsDiffEmpty);
    git(['checkout', '--', 'src/auth.ts'], dir); // restore
  });

  test('violation when test file (a rail) is modified', () => {
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => { it("new"); });\n');
    const files = getChangedFiles(dir, 'HEAD');
    const diff  = getDiff(dir, 'HEAD');
    const result = runChecks({ changedFiles: files, diffText: diff, cliRails: ['test/**'], ticket: null });
    const railViolations = result.violations.filter(v => v.type === 'rail-edit');
    assert.equal(railViolations.length, 1);
    assert.equal(railViolations[0].file, 'test/auth.test.ts');
    assert.ok(!result.railsDiffEmpty);
    git(['checkout', '--', 'test/auth.test.ts'], dir); // restore
  });

  test('uses ticket.rails when no cliRails', () => {
    writeFile(dir, 'test/auth.test.ts', 'describe("auth", () => { it("other"); });\n');
    const files = getChangedFiles(dir, 'HEAD');
    const diff  = getDiff(dir, 'HEAD');
    const ticket = { id: 'T1', title: 't', body: '', rails: ['test/**'] };
    const result = runChecks({ changedFiles: files, diffText: diff, cliRails: [], ticket });
    assert.equal(result.violations.filter(v => v.type === 'rail-edit').length, 1);
    git(['checkout', '--', 'test/auth.test.ts'], dir);
  });
});

describe('runChecks — suppression markers', () => {
  let dir;

  before(() => {
    dir = setupRepo();
    writeFile(dir, 'src/foo.ts', 'export function foo() {}\n');
    commit(dir, 'initial');
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('flags unapproved .skip( marker', () => {
    writeFile(dir, 'src/foo.ts', "export function foo() {}\nit.skip('broken', () => {});\n");
    const files = getChangedFiles(dir, 'HEAD');
    const diff  = getDiff(dir, 'HEAD');
    const ticket = { id: 'T1', title: 't', body: '' };
    const result = runChecks({ changedFiles: files, diffText: diff, cliRails: ['test/**'], ticket });
    const suppViolations = result.violations.filter(v => v.type === 'suppression');
    assert.equal(suppViolations.length, 1);
    assert.equal(suppViolations[0].marker, '.skip(');
    assert.ok(!result.suppressionsClean);
    git(['checkout', '--', 'src/foo.ts'], dir);
  });

  test('does NOT flag a suppression marker inside a documentation (.md) file', () => {
    // A doc that discusses the markers in prose is a false positive — prose is not
    // executed. The end-to-end gate (this is the runChecks path the CI gate shells to)
    // must skip it. Regression guard for the adlc-antigravity doctrine-skill false positive.
    // The marker token is assembled (not literal, incl. the variable name) so this
    // scanned test file's own added line does not trip the suppression gate —
    // see suppressions.test.mjs for the full rationale.
    const XF = 'x' + 'fail';
    writeFile(dir, 'docs/rules.md', `# rules\nNewly added skip/${XF}/suppression markers fail review.\n`);
    // STAGE the new file so it appears in `git diff HEAD` as an added file. Without this
    // the untracked doc is invisible to the diff, the marker never reaches runChecks, and
    // the test is a FALSE GREEN that passes even if the doc-skip logic is deleted.
    git(['add', 'docs/rules.md'], dir);
    let result, diff;
    try {
      diff = getDiff(dir, 'HEAD');
      const files = getChangedFiles(dir, 'HEAD');
      const ticket = { id: 'T1', title: 't', body: '' };
      result = runChecks({ changedFiles: files, diffText: diff, cliRails: ['test/**'], ticket });
    } finally {
      // Always clean up (F4) — even if runChecks throws — so the shared repo stays pristine.
      git(['reset', '-q', 'HEAD', '--', 'docs/rules.md'], dir);
      rmSync(join(dir, 'docs/rules.md'), { force: true });
    }
    // Precondition: the marker MUST actually be in the scanned diff, else the assertion
    // below is vacuous (this is what makes the test load-bearing, not a false green).
    assert.ok(diff.includes('docs/rules.md') && diff.includes(XF), 'the doc marker must be in the diff under test');
    assert.equal(result.violations.filter(v => v.type === 'suppression').length, 0);
    assert.ok(result.suppressionsClean);
  });

  test('allows .skip( when ticket body has allow-suppression', () => {
    writeFile(dir, 'src/foo.ts', "export function foo() {}\nit.skip('known', () => {});\n");
    const files = getChangedFiles(dir, 'HEAD');
    const diff  = getDiff(dir, 'HEAD');
    const ticket = { id: 'T1', title: 't', body: 'allow-suppression: .skip(' };
    const result = runChecks({ changedFiles: files, diffText: diff, cliRails: ['test/**'], ticket });
    const suppViolations = result.violations.filter(v => v.type === 'suppression');
    assert.equal(suppViolations.length, 0);
    assert.ok(result.suppressionsClean);
    git(['checkout', '--', 'src/foo.ts'], dir);
  });

  test('allows one marker but blocks another', () => {
    writeFile(dir, 'src/foo.ts',
      "export function foo() {}\nit.skip('ok', () => {});\n// @ts-ignore\n");
    const files = getChangedFiles(dir, 'HEAD');
    const diff  = getDiff(dir, 'HEAD');
    const ticket = { id: 'T1', title: 't', body: 'allow-suppression: .skip(' };
    const result = runChecks({ changedFiles: files, diffText: diff, cliRails: ['test/**'], ticket });
    const suppViolations = result.violations.filter(v => v.type === 'suppression');
    // @ts-ignore not allowed; .skip( is allowed
    assert.equal(suppViolations.length, 1);
    assert.equal(suppViolations[0].marker, '@ts-ignore');
    git(['checkout', '--', 'src/foo.ts'], dir);
  });

  test('no violations when diff is clean', () => {
    writeFile(dir, 'src/foo.ts', "export function foo() { return 1; }\n");
    const files = getChangedFiles(dir, 'HEAD');
    const diff  = getDiff(dir, 'HEAD');
    const ticket = { id: 'T1', title: 't', body: '' };
    const result = runChecks({ changedFiles: files, diffText: diff, cliRails: ['test/**'], ticket });
    assert.equal(result.violations.length, 0);
    assert.ok(result.suppressionsClean);
    assert.ok(result.railsDiffEmpty);
    git(['checkout', '--', 'src/foo.ts'], dir);
  });
});

describe('runChecks — railGlobError', () => {
  test('railGlobError is set when no rails resolvable', () => {
    const result = runChecks({
      changedFiles: [],
      diffText: '',
      cliRails: [],
      ticket: null,
    });
    assert.ok(result.railGlobError);
  });

  test('railGlobError is null when cliRails supplied', () => {
    const result = runChecks({
      changedFiles: [],
      diffText: '',
      cliRails: ['test/**'],
      ticket: null,
    });
    assert.equal(result.railGlobError, null);
  });
});
