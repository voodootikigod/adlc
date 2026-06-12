// test/integration.test.mjs — End-to-end tests using scratch git repos.
// Creates synthetic commit history + import graphs, tests hot-score math,
// exclusion rules, {file} substitution, and findings ledger append.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Create a scratch git repo with a given set of files and a synthetic commit
 * history. Each entry in `history` is an array of [file, content] pairs that
 * get committed together.
 *
 * Returns the repo root path.
 */
function makeRepo(history) {
  const tmp = mkdtempSync(join(tmpdir(), 'mr-int-'));
  git(['init', '-b', 'main'], tmp);
  git(['config', 'user.email', 'test@example.com'], tmp);
  git(['config', 'user.name', 'Test'], tmp);

  for (const [i, changes] of history.entries()) {
    for (const [file, content] of changes) {
      const full = join(tmp, file);
      mkdirSync(join(tmp, file, '..'), { recursive: true });
      writeFileSync(full, content);
      git(['add', file], tmp);
    }
    git(['commit', '-m', `commit ${i}`], tmp);
  }
  return tmp;
}

// ---------------------------------------------------------------------------
// Integration test: hot-score math via CLI
// ---------------------------------------------------------------------------

describe('integration: hot-score math', () => {
  let tmp;

  before(() => {
    // Build a repo where:
    //   src/hot.mjs is touched 5 times (high churn)
    //   src/cold.mjs is touched 1 time (low churn)
    //   src/importer.mjs imports hot.mjs (adds inDegree to hot)
    //   src/also-imports.mjs imports hot.mjs (inDegree=2 for hot)
    const history = [
      // commit 0: initial files
      [
        ['src/hot.mjs', `export const hot = 1;`],
        ['src/cold.mjs', `export const cold = 1;`],
        ['src/importer.mjs', `import { hot } from './hot.mjs';`],
        ['src/also-imports.mjs', `import { hot } from './hot.mjs';`],
      ],
      // commits 1-4: touch hot.mjs repeatedly
      [['src/hot.mjs', `export const hot = 2;`]],
      [['src/hot.mjs', `export const hot = 3;`]],
      [['src/hot.mjs', `export const hot = 4;`]],
      [['src/hot.mjs', `export const hot = 5;`]],
    ];
    tmp = makeRepo(history);
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('top file is hot.mjs with correct score', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--top', '5', '--json'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, 'plan');
    const files = out.files;
    assert.ok(files.length > 0, 'should have files');

    const hotRow = files.find(f => f.file === 'src/hot.mjs');
    assert.ok(hotRow, 'hot.mjs should be in results');
    // hot.mjs: churn=5, inDegree=2, score=5*(1+2)=15
    assert.equal(hotRow.churn, 5, 'hot.mjs churn should be 5');
    assert.equal(hotRow.inDegree, 2, 'hot.mjs inDegree should be 2');
    assert.equal(hotRow.score, 15, 'hot.mjs score should be 15');

    // hot.mjs should rank first
    assert.equal(files[0].file, 'src/hot.mjs', 'hot.mjs should be top file');
  });

  it('cold.mjs has lower score than hot.mjs', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--top', '10', '--json'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    const out = JSON.parse(result.stdout);
    const hotRow = out.files.find(f => f.file === 'src/hot.mjs');
    const coldRow = out.files.find(f => f.file === 'src/cold.mjs');
    assert.ok(hotRow && coldRow, 'both files should appear');
    assert.ok(hotRow.score > coldRow.score, 'hot should outrank cold');
  });
});

// ---------------------------------------------------------------------------
// Integration test: test/spec file exclusion
// ---------------------------------------------------------------------------

describe('integration: exclusion rules', () => {
  let tmp;

  before(() => {
    const history = [
      [
        ['src/main.mjs', `export const x = 1;`],
        ['src/main.test.mjs', `import { x } from './main.mjs';`],
        ['src/utils.spec.ts', `import { x } from './main.mjs';`],
        ['README.md', '# hello'],
        ['package.json', '{}'],
      ],
      [['src/main.mjs', `export const x = 2;`]],
      [['src/main.test.mjs', `import { x } from './main.mjs'; // v2`]],
    ];
    tmp = makeRepo(history);
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('test files are not in plan output', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--top', '20', '--json'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    for (const row of out.files) {
      assert.ok(
        !row.file.includes('.test.') && !row.file.includes('.spec.'),
        `test file should be excluded: ${row.file}`
      );
    }
  });

  it('non-source files (md, json) are not in plan output', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--top', '20', '--json'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    const out = JSON.parse(result.stdout);
    for (const row of out.files) {
      assert.ok(
        !row.file.endsWith('.md') && !row.file.endsWith('.json'),
        `non-source file should be excluded: ${row.file}`
      );
    }
  });

  it('main.mjs inDegree is 0 (test files excluded from graph)', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--top', '5', '--json'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    const out = JSON.parse(result.stdout);
    const mainRow = out.files.find(f => f.file === 'src/main.mjs');
    // Test files are excluded from import graph, so nothing should import main.mjs
    assert.ok(mainRow, 'main.mjs should be in output');
    assert.equal(mainRow.inDegree, 0, 'inDegree should be 0 (test files excluded)');
  });
});

// ---------------------------------------------------------------------------
// Integration test: --review-cmd {file} substitution + findings ledger
// ---------------------------------------------------------------------------

describe('integration: review-cmd findings ledger', () => {
  let tmp;
  let adlcDir;

  before(() => {
    const history = [
      [
        ['src/target.mjs', `export const v = 1;`],
        ['src/importer.mjs', `import { v } from './target.mjs';`],
      ],
      [['src/target.mjs', `export const v = 2;`]],
      [['src/target.mjs', `export const v = 3;`]],
    ];
    tmp = makeRepo(history);
    adlcDir = join(tmp, '.adlc');
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('runs review-cmd with {file} substituted', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    // Fake review command: prints a finding for the file
    const reviewCmd = `node -e "console.log('- finding in {file}')"`;
    const result = spawnSync('node', [bin, '--top', '3', '--review-cmd', reviewCmd, '--json'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, 'review');
    assert.ok(out.totalFindings >= 1, 'should have at least one finding');

    // Each result should show the substituted file name in the finding desc
    for (const fileResult of out.results) {
      for (const finding of fileResult.findings) {
        // The fake cmd prints "- finding in <file>" so desc should contain file name
        assert.ok(finding.desc.includes(fileResult.file), `finding desc should contain file name: ${finding.desc}`);
      }
    }
  });

  it('appends findings to .adlc/findings.jsonl ledger', () => {
    const ledgerFile = join(adlcDir, 'findings.jsonl');
    assert.ok(existsSync(ledgerFile), 'findings.jsonl should exist after review run');

    const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length >= 1, 'should have at least one finding in ledger');

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.tool, 'model-ratchet');
    assert.equal(entry.category, 'ratchet');
    assert.equal(entry.severity, 'unknown');
    assert.ok(entry.ts, 'should have timestamp');
    assert.ok(entry.file, 'should have file');
    assert.ok(entry.desc, 'should have desc');
  });

  it('finding entries have correct schema', () => {
    const ledgerFile = join(adlcDir, 'findings.jsonl');
    const lines = readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      // Required fields per CONVENTIONS
      assert.ok('ts' in entry, 'missing ts');
      assert.ok('tool' in entry, 'missing tool');
      assert.ok('file' in entry, 'missing file');
      assert.ok('category' in entry, 'missing category');
      assert.ok('severity' in entry, 'missing severity');
      assert.ok('desc' in entry, 'missing desc');
    }
  });
});

// ---------------------------------------------------------------------------
// Integration test: dry-run mode (no --review-cmd)
// ---------------------------------------------------------------------------

describe('integration: dry-run (plan) mode', () => {
  let tmp;

  before(() => {
    const history = [
      [['src/a.mjs', `export const a = 1;`]],
      [['src/a.mjs', `export const a = 2;`]],
    ];
    tmp = makeRepo(history);
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('exits 0 without review-cmd', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--json'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, 'plan');
  });

  it('exits 0 with --dry-run even when review-cmd provided', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync(
      'node',
      [bin, '--dry-run', '--review-cmd', 'echo {file}', '--json'],
      { cwd: tmp, encoding: 'utf8' }
    );
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.mode, 'plan');
  });
});

// ---------------------------------------------------------------------------
// Integration test: error on non-git directory
// ---------------------------------------------------------------------------

describe('integration: non-git-repo error', () => {
  let tmp;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mr-nogit-'));
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('exits 1 when not a git repo', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--json'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 1, 'should exit 1 for non-git-repo');
    assert.ok(result.stderr.includes('not a git'), `stderr: ${result.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// Integration test: --top flag limits output
// ---------------------------------------------------------------------------

describe('integration: --top flag', () => {
  let tmp;

  before(() => {
    const history = [
      [
        ['src/a.mjs', 'export const a = 1;'],
        ['src/b.mjs', 'export const b = 1;'],
        ['src/c.mjs', 'export const c = 1;'],
        ['src/d.mjs', 'export const d = 1;'],
        ['src/e.mjs', 'export const e = 1;'],
      ],
      [['src/a.mjs', 'export const a = 2;']],
      [['src/b.mjs', 'export const b = 2;']],
      [['src/c.mjs', 'export const c = 2;']],
      [['src/d.mjs', 'export const d = 2;']],
    ];
    tmp = makeRepo(history);
  });

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it('limits output to --top N files', () => {
    const bin = resolve(import.meta.dirname, '../bin/model-ratchet.mjs');
    const result = spawnSync('node', [bin, '--top', '2', '--json'], {
      cwd: tmp,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.files.length, 2, 'should return exactly 2 files');
  });
});
