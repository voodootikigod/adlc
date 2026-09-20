// test/empty-selection.test.mjs — Acceptance tests for issue #688:
// model-ratchet empty selection handling in review mode and SOURCE_EXTS widening.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { SOURCE_EXTS, isExcluded, walkSourceFiles } from '../lib/walk.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = resolve(__dirname, '../bin/model-ratchet.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeRepoWithoutSources() {
  const tmp = mkdtempSync(join(tmpdir(), 'mr-empty-'));
  git(['init', '-b', 'main'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test'], tmp);

  // Write only non-source files (README.md, doc.txt)
  writeFileSync(join(tmp, 'README.md'), '# No code here\n');
  writeFileSync(join(tmp, 'notes.txt'), 'just text\n');
  git(['add', '.'], tmp);
  git(['commit', '-m', 'initial commit without source files'], tmp);

  return tmp;
}

describe('AC1: Review mode with 0 selected files exits 2 and prints warning', () => {
  let tmp;

  before(() => {
    tmp = makeRepoWithoutSources();
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exits code 2 and writes warning to stderr when no candidate files are selected', () => {
    const result = spawnSync(
      'node',
      [bin, '--review-cmd', 'echo {file}'],
      { cwd: tmp, encoding: 'utf8' }
    );

    assert.equal(result.status, 2, `expected exit code 2, got ${result.status}. stderr: ${result.stderr}`);
    assert.match(
      result.stderr,
      /no source files.*selected/i,
      `expected stderr to warn about no source files selected, got: ${result.stderr}`
    );
  });

  it('exits code 2, writes warning to stderr, and surfaces selectedCount: 0 in --json output', () => {
    const result = spawnSync(
      'node',
      [bin, '--review-cmd', 'echo {file}', '--json'],
      { cwd: tmp, encoding: 'utf8' }
    );

    assert.equal(result.status, 2, `expected exit code 2, got ${result.status}. stderr: ${result.stderr}`);
    assert.match(
      result.stderr,
      /no source files.*selected/i,
      `expected stderr to warn about no source files selected, got: ${result.stderr}`
    );

    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, 'review');
    assert.equal(out.selectedCount, 0, 'JSON output should surface selectedCount: 0');
    assert.deepEqual(out.files, [], 'JSON output files should be empty array');
    assert.deepEqual(out.results, [], 'JSON output results should be empty array');
    assert.equal(out.totalFindings, 0, 'totalFindings should be 0');
    assert.equal(out.totalRejected, 0, 'totalRejected should be 0');
    assert.equal(out.operationalError, false, 'operationalError should be false');
  });
});

describe('AC2: Review mode with --allow-empty exits 0 when 0 files selected', () => {
  let tmp;

  before(() => {
    tmp = makeRepoWithoutSources();
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('exits code 0 with --allow-empty in human-readable mode', () => {
    const result = spawnSync(
      'node',
      [bin, '--review-cmd', 'echo {file}', '--allow-empty'],
      { cwd: tmp, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, `expected exit code 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /no source files.*selected/i);
  });

  it('exits code 0 with --allow-empty and surfaces selectedCount: 0 in --json mode', () => {
    const result = spawnSync(
      'node',
      [bin, '--review-cmd', 'echo {file}', '--allow-empty', '--json'],
      { cwd: tmp, encoding: 'utf8' }
    );

    assert.equal(result.status, 0, `expected exit code 0, got ${result.status}. stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, 'review');
    assert.equal(out.selectedCount, 0, 'JSON output should surface selectedCount: 0');
    assert.deepEqual(out.files, []);
    assert.equal(out.totalFindings, 0);
  });
});

describe('AC3: SOURCE_EXTS recognizes .cjs, .mts, .cts, .jsx files', () => {
  it('SOURCE_EXTS set contains new extensions', () => {
    assert.ok(SOURCE_EXTS.has('.cjs'), 'SOURCE_EXTS should include .cjs');
    assert.ok(SOURCE_EXTS.has('.mts'), 'SOURCE_EXTS should include .mts');
    assert.ok(SOURCE_EXTS.has('.cts'), 'SOURCE_EXTS should include .cts');
    assert.ok(SOURCE_EXTS.has('.jsx'), 'SOURCE_EXTS should include .jsx');
    // Also retains existing extensions
    assert.ok(SOURCE_EXTS.has('.mjs'), 'SOURCE_EXTS should retain .mjs');
    assert.ok(SOURCE_EXTS.has('.js'), 'SOURCE_EXTS should retain .js');
    assert.ok(SOURCE_EXTS.has('.ts'), 'SOURCE_EXTS should retain .ts');
    assert.ok(SOURCE_EXTS.has('.tsx'), 'SOURCE_EXTS should retain .tsx');
    assert.ok(SOURCE_EXTS.has('.py'), 'SOURCE_EXTS should retain .py');
  });

  it('isExcluded returns false for .cjs, .mts, .cts, .jsx files', () => {
    assert.equal(isExcluded('src/module.cjs'), false);
    assert.equal(isExcluded('src/module.mts'), false);
    assert.equal(isExcluded('src/module.cts'), false);
    assert.equal(isExcluded('src/component.jsx'), false);
  });

  it('walkSourceFiles discovers .cjs, .mts, .cts, .jsx files in directories', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mr-exts-'));
    try {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src/legacy.cjs'), 'module.exports = {};');
      writeFileSync(join(tmp, 'src/esm.mts'), 'export const m = 1;');
      writeFileSync(join(tmp, 'src/common.cts'), 'export const c = 2;');
      writeFileSync(join(tmp, 'src/view.jsx'), 'export const View = () => null;');
      writeFileSync(join(tmp, 'src/ignore.md'), '# Ignore me');

      const found = walkSourceFiles(tmp).map(f => f.replace(/\\/g, '/'));
      assert.ok(found.includes('src/legacy.cjs'), 'should include legacy.cjs');
      assert.ok(found.includes('src/esm.mts'), 'should include esm.mts');
      assert.ok(found.includes('src/common.cts'), 'should include common.cts');
      assert.ok(found.includes('src/view.jsx'), 'should include view.jsx');
      assert.ok(!found.includes('src/ignore.md'), 'should not include ignore.md');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('CLI --help contract', () => {
  it('--help documents --allow-empty flag and gate failure exit code 2', () => {
    const result = spawnSync('node', [bin, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /--allow-empty\s+Allow review mode to exit 0 when zero candidate files are selected/,
      '--help must document --allow-empty flag description'
    );
    assert.match(
      result.stdout,
      /2\s+Gate failure \(review mode with zero candidate files selected and --allow-empty not set\)/,
      '--help must document gate failure exit code 2'
    );
  });
});

