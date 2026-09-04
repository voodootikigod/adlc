// #739 — a --sanctioned-add exemption must be disclosed everywhere the gate's
// verdict is read: checkRailEdits' own return value, runChecks' summary, the CLI's
// --json output, and the --record manifest entry. Before this, the exemption left
// no trace anywhere the bin controls: --json emitted `railsDiffEmpty: true` with no
// sanctioned-paths field, and the manifest recorded a clean rails-diff-empty proof
// for a run in which railed paths were in fact exempted.
//
// railsDiffEmpty's existing meaning and value are NOT changed by this file — it is
// still true whenever there are zero rail-edit violations, exemptions included.
// packages/runner/lib/assertions.mjs asserts on that exact field; this ticket is
// additive only.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { checkRailEdits } from '../lib/rails.mjs';
import { runChecks } from '../lib/check.mjs';
import { buildResult } from '../lib/output.mjs';
import { readEntries, ADLC_DIR } from '../../core/index.mjs';

const BIN = fileURLToPath(new URL('../bin/rails-guard.mjs', import.meta.url));

// ── AC1: checkRailEdits returns { violations, sanctioned } ─────────────────────

describe('checkRailEdits — sanctioned disclosure', () => {
  test('a sanctioned match is reported in `sanctioned`, not in `violations`', () => {
    const { violations, sanctioned } = checkRailEdits(
      ['test/frozen/new.mjs', 'test/frozen/other.mjs'],
      ['test/frozen/**'],
      null,
      new Set(['test/frozen/new.mjs'])
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'test/frozen/other.mjs');
    assert.equal(sanctioned.length, 1);
    assert.equal(sanctioned[0].file, 'test/frozen/new.mjs');
    assert.deepEqual(sanctioned[0].globs, ['test/frozen/**']);
  });

  test('no sanctionedAdditions set: sanctioned is empty, violations unchanged', () => {
    const { violations, sanctioned } = checkRailEdits(['test/frozen/x.mjs'], ['test/frozen/**']);
    assert.equal(violations.length, 1);
    assert.deepEqual(sanctioned, []);
  });

  test('the #228 version-only exemption is NOT reported as sanctioned', () => {
    const PKG = 'packages/build-gate/package.json';
    const mk = (version) => JSON.stringify({ name: '@adlc/build-gate', version, main: 'lib/i.mjs' }, null, 2) + '\n';
    const before = mk('1.5.0');
    const bumped = mk('1.5.1');
    const resolver = (file) => (file === PKG ? { before, after: bumped } : null);
    const { violations, sanctioned } = checkRailEdits([PKG], ['packages/build-gate/**'], resolver, new Set());
    assert.equal(violations.length, 0);
    assert.deepEqual(sanctioned, [], 'the version-only exemption is a different, pre-existing class — not disclosed here');
  });
});

// ── AC2: runChecks threads sanctionedAdditions through, railsDiffEmpty unchanged ─

describe('runChecks — sanctionedAdditions field', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rails-guard-sanction-check-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    mkdirSync(join(dir, 'test', 'frozen'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), 'baseline\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base'], { cwd: dir });
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('a sanctioned addition: sanctionedAdditions names it, railsDiffEmpty stays true', () => {
    writeFileSync(join(dir, 'test', 'frozen', 'new.test.mjs'), 'export const t = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const files = execFileSync('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: dir, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const diff = execFileSync('git', ['diff', '--cached', 'HEAD', '--'], { cwd: dir, encoding: 'utf8' });
    const result = runChecks({
      changedFiles: files,
      diffText: diff,
      cliRails: ['test/frozen/**'],
      ticket: null,
      sanctionedAdditions: new Set(['test/frozen/new.test.mjs']),
    });
    assert.equal(result.violations.filter((v) => v.type === 'rail-edit').length, 0);
    assert.ok(result.railsDiffEmpty, 'railsDiffEmpty must stay true — its meaning is unchanged by disclosure');
    assert.deepEqual(result.sanctionedAdditions, ['test/frozen/new.test.mjs']);
  });

  test('no sanctioned files: sanctionedAdditions is an empty array', () => {
    const result = runChecks({
      changedFiles: [],
      diffText: '',
      cliRails: ['test/frozen/**'],
      ticket: null,
    });
    assert.deepEqual(result.sanctionedAdditions, []);
  });
});

// ── AC3 + AC4: CLI --json output and --record manifest entry ───────────────────

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
function runBin(args, cwd) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
}

describe('CLI --json and --record: sanctionedAdditions disclosure', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rails-guard-sanction-cli-'));
    git(['init', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    writeFile(dir, 'README.md', 'baseline\n');
    commit(dir, 'initial');
  });

  after(() => { rmSync(dir, { recursive: true, force: true }); });

  test('--json on a --sanctioned-add run includes a non-empty sanctionedAdditions array', () => {
    writeFile(dir, 'test/frozen/new.test.mjs', 'export const t = 1;\n');
    git(['add', '-A'], dir);
    const result = runBin(
      ['--rails', 'test/frozen/**', '--sanctioned-add', 'test/frozen/new.test.mjs', '--json', '--base', 'HEAD'],
      dir
    );
    assert.equal(result.status, 0, `bin exited ${result.status}; stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.passed, true);
    assert.equal(parsed.railsDiffEmpty, true);
    assert.deepEqual(parsed.sanctionedAdditions, ['test/frozen/new.test.mjs']);
    git(['reset', '-q', 'HEAD', '--', 'test/frozen/new.test.mjs'], dir);
    rmSync(join(dir, 'test', 'frozen', 'new.test.mjs'), { force: true });
  });

  test('--json on an ordinary clean run (no exemptions) has sanctionedAdditions: []', () => {
    const result = runBin(['--rails', 'test/**', '--json', '--base', 'HEAD'], dir);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.sanctionedAdditions, []);
  });

  test('--record on a sanctioned-exempted clean run records sanctionedAdditions in the manifest entry', () => {
    writeFile(dir, 'test/frozen/second.test.mjs', 'export const t = 2;\n');
    git(['add', '-A'], dir);
    const result = runBin(
      ['--rails', 'test/frozen/**', '--sanctioned-add', 'test/frozen/second.test.mjs', '--record', '--base', 'HEAD'],
      dir
    );
    assert.equal(result.status, 0, `bin exited ${result.status}; stderr: ${result.stderr}`);
    commit(dir, 'author the sanctioned file');

    const adlcDir = join(dir, ADLC_DIR);
    const { entries } = readEntries('manifest', adlcDir);
    const e = entries[entries.length - 1];
    assert.equal(e.type, 'rails-check');
    assert.equal(e.railsDiffEmpty, true, 'railsDiffEmpty stays true — unchanged semantics');
    assert.deepEqual(e.sanctionedAdditions, ['test/frozen/second.test.mjs']);
  });

  test('human-readable output prints sanctioned paths on stderr when exemptions were used', () => {
    writeFile(dir, 'test/frozen/third.test.mjs', 'export const t = 3;\n');
    git(['add', '-A'], dir);
    const result = runBin(
      ['--rails', 'test/frozen/**', '--sanctioned-add', 'test/frozen/third.test.mjs', '--base', 'HEAD'],
      dir
    );
    assert.equal(result.status, 0);
    assert.match(result.stderr, /test\/frozen\/third\.test\.mjs/, 'the sanctioned path must be disclosed on stderr');
    git(['reset', '-q', 'HEAD', '--', 'test/frozen/third.test.mjs'], dir);
    rmSync(join(dir, 'test', 'frozen', 'third.test.mjs'), { force: true });
  });
});

// ── buildResult: additive field, existing fields untouched ─────────────────────

describe('buildResult — sanctionedAdditions is additive', () => {
  test('sanctionedAdditions passes through; railsDiffEmpty and other fields unchanged', () => {
    const result = buildResult({
      violations: [],
      railGlobs: ['test/**'],
      railGlobError: null,
      railsDiffEmpty: true,
      suppressionsClean: true,
      sanctionedAdditions: ['test/x.mjs'],
      base: 'HEAD',
      ticket: null,
    });
    assert.deepEqual(result.sanctionedAdditions, ['test/x.mjs']);
    assert.equal(result.railsDiffEmpty, true);
    assert.equal(result.passed, true);
  });

  test('omitting sanctionedAdditions defaults to an empty array (backward compatible)', () => {
    const result = buildResult({
      violations: [],
      railGlobs: [],
      railGlobError: null,
      railsDiffEmpty: true,
      suppressionsClean: true,
      base: 'HEAD',
      ticket: null,
    });
    assert.deepEqual(result.sanctionedAdditions, []);
  });
});
