// test/subdirectory-root.test.mjs — Verify model-ratchet behavior when run from a subdirectory.
// Covers AC1 (non-zero churn for hot files matching repo root) and
// AC2 (findings written to <root>/.adlc/findings.jsonl, not <cwd>/.adlc/findings.jsonl).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(__dirname, '../bin/model-ratchet.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('model-ratchet from subdirectory', () => {
  it('AC1: calculates non-zero churn for hot files matching repo root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-sub-ac1-'));
    try {
      git(['init', '-b', 'main'], dir);
      git(['config', 'user.email', 'test@example.com'], dir);
      git(['config', 'user.name', 'Test'], dir);

      const pkgADir = join(dir, 'packages', 'pkg-a', 'src');
      const pkgBDir = join(dir, 'packages', 'pkg-b', 'src');
      mkdirSync(pkgADir, { recursive: true });
      mkdirSync(pkgBDir, { recursive: true });

      writeFileSync(join(pkgADir, 'hot.mjs'), 'export const a = 1;\n');
      writeFileSync(join(pkgBDir, 'importer.mjs'), "import { a } from '../../pkg-a/src/hot.mjs';\n");
      git(['add', '.'], dir);
      git(['commit', '-m', 'commit 1'], dir);

      writeFileSync(join(pkgADir, 'hot.mjs'), 'export const a = 2;\n');
      git(['add', '.'], dir);
      git(['commit', '-m', 'commit 2'], dir);

      writeFileSync(join(pkgADir, 'hot.mjs'), 'export const a = 3;\n');
      git(['add', '.'], dir);
      git(['commit', '-m', 'commit 3'], dir);

      // Run from packages/pkg-b subdirectory
      const subCwd = join(dir, 'packages', 'pkg-b');
      const result = spawnSync('node', [binPath, '--top', '5', '--json'], {
        cwd: subCwd,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const out = JSON.parse(result.stdout);
      assert.equal(out.mode, 'plan');

      // Candidate files must be relative to repo root
      const hotRow = out.files.find(f => f.file === 'packages/pkg-a/src/hot.mjs');
      assert.ok(hotRow, 'packages/pkg-a/src/hot.mjs should be present in plan');
      assert.equal(hotRow.churn, 3, `expected churn to be 3, got ${hotRow.churn}`);
      assert.ok(hotRow.score > 0, `expected non-zero score, got ${hotRow.score}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC2: targets <root>/.adlc/findings.jsonl rather than subdirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-sub-ac2-'));
    try {
      git(['init', '-b', 'main'], dir);
      git(['config', 'user.email', 'test@example.com'], dir);
      git(['config', 'user.name', 'Test'], dir);

      const subDir = join(dir, 'packages', 'pkg-sub');
      mkdirSync(subDir, { recursive: true });
      writeFileSync(join(subDir, 'target.mjs'), 'export const x = 1;\n');
      git(['add', '.'], dir);
      git(['commit', '-m', 'init'], dir);

      const reviewCmd = `node -e "console.log('- finding in {file}')"`;
      const result = spawnSync('node', [binPath, '--top', '5', '--review-cmd', reviewCmd, '--json'], {
        cwd: subDir,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const out = JSON.parse(result.stdout);
      assert.equal(out.mode, 'review');
      assert.ok(out.totalFindings >= 1, 'should have recorded at least one finding');

      const rootLedger = join(dir, '.adlc', 'findings.jsonl');
      const subLedger = join(subDir, '.adlc', 'findings.jsonl');

      assert.ok(existsSync(rootLedger), 'findings ledger must exist at repo root');
      assert.ok(!existsSync(subLedger), 'findings ledger must NOT exist in subdirectory');

      const content = readFileSync(rootLedger, 'utf8');
      assert.ok(content.includes('packages/pkg-sub/target.mjs'), 'finding should record repo-relative path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs review-cmd with cwd set to repo root so root-relative {file} can be opened', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-sub-read-'));
    try {
      git(['init', '-b', 'main'], dir);
      git(['config', 'user.email', 'test@example.com'], dir);
      git(['config', 'user.name', 'Test'], dir);

      const pkgADir = join(dir, 'packages', 'pkg-a');
      const pkgBDir = join(dir, 'packages', 'pkg-b');
      mkdirSync(pkgADir, { recursive: true });
      mkdirSync(pkgBDir, { recursive: true });

      writeFileSync(join(pkgADir, 'target.mjs'), 'export const target = true;\n');
      git(['add', '.'], dir);
      git(['commit', '-m', 'init'], dir);

      // Review command actually attempts to read {file} relative to its process cwd.
      // If run in pkg-b, packages/pkg-a/target.mjs cannot be resolved and node exits 1.
      const reviewCmd = `node -e "const fs = require('node:fs'); fs.readFileSync('{file}'); console.log('- verified {file}')"`;
      const result = spawnSync('node', [binPath, '--top', '5', '--review-cmd', reviewCmd, '--json'], {
        cwd: pkgBDir,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const out = JSON.parse(result.stdout);
      assert.equal(out.mode, 'review');
      assert.equal(out.operationalError, false);
      assert.equal(out.totalFindings, 1);
      assert.ok(out.results[0].findings[0].desc.includes('packages/pkg-a/target.mjs'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
