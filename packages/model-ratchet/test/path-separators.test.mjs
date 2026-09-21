// test/path-separators.test.mjs — Verify Windows path separator normalization.
// Covers AC1 (walkSourceFiles returns forward-slash paths),
// AC2 (computeScores matches churnMap/inDegreeMap with backslash candidate paths),
// and computeInDegree / resolveSpecifier cross-platform normalization.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  walkSourceFiles,
  computeInDegree,
  resolveSpecifier,
  isTestFile,
  isExcluded,
} from '../lib/walk.mjs';
import { computeScores } from '../lib/score.mjs';

describe('AC1: walkSourceFiles path separator normalization', () => {
  it('walkSourceFiles returns forward-slash paths even when relative path has backslashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-path-sep-ac1-'));
    try {
      // Create real directories so the fixture is portable across Linux and Windows
      mkdirSync(join(dir, 'src', 'nested'), { recursive: true });
      writeFileSync(join(dir, 'src', 'hot.mjs'), 'export const x = 1;\n');
      writeFileSync(join(dir, 'src', 'nested', 'deep.mjs'), 'export const d = 2;\n');

      const nativeFiles = walkSourceFiles(dir).sort();
      assert.deepEqual(nativeFiles, ['src/hot.mjs', 'src/nested/deep.mjs']);
      for (const file of nativeFiles) {
        assert.ok(!file.includes('\\'), `native path ${file} must not contain backslashes`);
      }

      // Explicit simulation of Windows backslash relative() paths on POSIX runners
      const simulatedFiles = walkSourceFiles(dir, {
        _relative: (from, to) => relative(from, to).replaceAll('/', '\\'),
      }).sort();
      assert.deepEqual(simulatedFiles, ['src/hot.mjs', 'src/nested/deep.mjs']);
      for (const file of simulatedFiles) {
        assert.ok(!file.includes('\\'), `simulated path ${file} must not contain backslashes`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isTestFile handles backslash paths', () => {
    assert.equal(isTestFile('src\\foo.test.js'), true);
    assert.equal(isTestFile('test\\thing.mjs'), true);
    assert.equal(isTestFile('src\\__tests__\\bar.ts'), true);
    assert.equal(isTestFile('src\\utils.mjs'), false);
  });

  it('isExcluded handles backslash paths', () => {
    assert.equal(isExcluded('src\\foo.test.js'), true);
    assert.equal(isExcluded('README.md'), true);
    assert.equal(isExcluded('docs\\guide.md'), true);
    assert.equal(isExcluded('src\\hot.mjs'), false);
  });
});

describe('AC2: computeScores with Windows backslash candidate files', () => {
  it('computeScores matches churnMap and inDegreeMap entries when candidate files contain Windows backslashes', () => {
    const churnMap = {
      'src/hot.mjs': 12,
      'src/cold.mjs': 2,
    };
    const inDegreeMap = {
      'src/hot.mjs': 3,
      'src/cold.mjs': 0,
    };
    const candidateFiles = ['src\\hot.mjs', 'src\\cold.mjs'];

    const rows = computeScores(churnMap, inDegreeMap, candidateFiles);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].file, 'src/hot.mjs');
    assert.equal(rows[0].churn, 12);
    assert.equal(rows[0].inDegree, 3);
    assert.equal(rows[0].score, 48); // 12 * (1 + 3)

    assert.equal(rows[1].file, 'src/cold.mjs');
    assert.equal(rows[1].churn, 2);
    assert.equal(rows[1].inDegree, 0);
    assert.equal(rows[1].score, 2); // 2 * (1 + 0)

    for (const row of rows) {
      assert.ok(!row.file.includes('\\'), `row file ${row.file} must be normalized to forward slashes`);
    }
  });

  it('computeScores matches churnMap with backslash keys', () => {
    const churnMap = {
      'src\\hot.mjs': 8,
    };
    const inDegreeMap = {
      'src/hot.mjs': 1,
    };
    const candidateFiles = ['src/hot.mjs'];

    const rows = computeScores(churnMap, inDegreeMap, candidateFiles);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].file, 'src/hot.mjs');
    assert.equal(rows[0].churn, 8);
    assert.equal(rows[0].inDegree, 1);
    assert.equal(rows[0].score, 16); // 8 * (1 + 1)
  });
});

describe('computeInDegree and resolveSpecifier cross-platform normalization', () => {
  it('computeInDegree resolves imports and returns forward-slash keys when input files contain backslashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-path-sep-indeg-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'hot.mjs'), 'export const hot = 1;\n');
      writeFileSync(
        join(dir, 'src', 'consumer.mjs'),
        "import { hot } from './hot.mjs';\nimport { pkg } from 'external-pkg';\nimport { missing } from './missing.mjs';\nimport { self } from './consumer.mjs';\n"
      );

      // Pass candidate files with Windows backslashes
      const inDegree = computeInDegree(['src\\hot.mjs', 'src\\consumer.mjs'], dir);

      assert.equal(inDegree['src/hot.mjs'], 1, 'src/hot.mjs should be imported by consumer');
      assert.equal(inDegree['src/consumer.mjs'], 0, 'src/consumer.mjs self-import must not increment inDegree');
      assert.equal(inDegree[null], undefined, 'unresolved specifiers must not set null key in inDegree');
      assert.deepEqual(Object.keys(inDegree).sort(), ['src/consumer.mjs', 'src/hot.mjs']);
      for (const key of Object.keys(inDegree)) {
        assert.ok(!key.includes('\\'), `key ${key} must not contain backslashes`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolveSpecifier resolves relative imports when fromFile or specifier contains backslashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-path-sep-resolv-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'hot.mjs'), 'export const hot = 1;\n');
      writeFileSync(join(dir, 'src', 'consumer.mjs'), "export const c = 1;\n");

      const fileSet = new Set(['src/hot.mjs', 'src/consumer.mjs']);

      // fromFile has backslashes
      const res1 = resolveSpecifier('./hot.mjs', 'src\\consumer.mjs', dir, fileSet);
      assert.equal(res1, 'src/hot.mjs');

      // specifier has backslashes
      const res2 = resolveSpecifier('.\\hot.mjs', 'src/consumer.mjs', dir, fileSet);
      assert.equal(res2, 'src/hot.mjs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
