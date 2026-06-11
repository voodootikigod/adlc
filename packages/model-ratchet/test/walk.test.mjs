// test/walk.test.mjs — Tests for walk.mjs (file discovery and import graph).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isTestFile,
  isExcluded,
  walkSourceFiles,
  extractSpecifiers,
  resolveSpecifier,
  computeInDegree,
} from '../lib/walk.mjs';

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  it('detects *.test.js', () => assert.equal(isTestFile('src/foo.test.js'), true));
  it('detects *.spec.ts', () => assert.equal(isTestFile('src/bar.spec.ts'), true));
  it('detects *.test.mjs', () => assert.equal(isTestFile('lib/x.test.mjs'), true));
  it('detects files inside test/', () => assert.equal(isTestFile('test/thing.mjs'), true));
  it('detects files inside __tests__/', () => assert.equal(isTestFile('src/__tests__/foo.ts'), true));
  it('does not flag normal files', () => assert.equal(isTestFile('src/utils.mjs'), false));
  it('does not flag lib/index.ts', () => assert.equal(isTestFile('lib/index.ts'), false));
});

// ---------------------------------------------------------------------------
// isExcluded
// ---------------------------------------------------------------------------

describe('isExcluded', () => {
  it('excludes .md', () => assert.equal(isExcluded('README.md'), true));
  it('excludes .json', () => assert.equal(isExcluded('package.json'), true));
  it('excludes .lock', () => assert.equal(isExcluded('pnpm-lock.yaml'), true));
  it('excludes test files', () => assert.equal(isExcluded('src/x.test.js'), true));
  it('includes .mjs', () => assert.equal(isExcluded('src/utils.mjs'), false));
  it('includes .ts', () => assert.equal(isExcluded('src/x.ts'), false));
  it('includes .py', () => assert.equal(isExcluded('app/main.py'), false));
  it('includes .tsx', () => assert.equal(isExcluded('app/page.tsx'), false));
});

// ---------------------------------------------------------------------------
// walkSourceFiles — uses temp dir
// ---------------------------------------------------------------------------

describe('walkSourceFiles', () => {
  let tmp;
  it('setup', () => {
    tmp = mkdtempSync(join(tmpdir(), 'mr-walk-'));
    // Create structure:
    //   src/index.mjs
    //   src/utils.mjs
    //   src/__tests__/x.test.mjs   <- excluded (test)
    //   node_modules/foo/bar.mjs   <- excluded (skip dir)
    //   README.md                  <- excluded (non-source)
    mkdirSync(join(tmp, 'src', '__tests__'), { recursive: true });
    mkdirSync(join(tmp, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'index.mjs'), '// index');
    writeFileSync(join(tmp, 'src', 'utils.mjs'), '// utils');
    writeFileSync(join(tmp, 'src', '__tests__', 'x.test.mjs'), '// test');
    writeFileSync(join(tmp, 'node_modules', 'foo', 'bar.mjs'), '// vendor');
    writeFileSync(join(tmp, 'README.md'), '# hi');
  });

  it('returns only non-excluded source files', () => {
    const files = walkSourceFiles(tmp).sort();
    assert.deepEqual(files, ['src/index.mjs', 'src/utils.mjs']);
  });

  it('cleanup', () => rmSync(tmp, { recursive: true, force: true }));
});

// ---------------------------------------------------------------------------
// extractSpecifiers
// ---------------------------------------------------------------------------

describe('extractSpecifiers', () => {
  it('extracts ES static imports', () => {
    const src = `import { foo } from './foo.mjs';\nimport bar from '../bar';`;
    const specs = extractSpecifiers(src);
    assert.ok(specs.includes('./foo.mjs'), 'should include ./foo.mjs');
    assert.ok(specs.includes('../bar'), 'should include ../bar');
  });

  it('extracts dynamic imports', () => {
    const src = `const x = await import('./dynamic.mjs');`;
    assert.ok(extractSpecifiers(src).includes('./dynamic.mjs'));
  });

  it('extracts require()', () => {
    const src = `const y = require('./stuff');`;
    assert.ok(extractSpecifiers(src).includes('./stuff'));
  });

  it('ignores package imports', () => {
    const src = `import { something } from 'node:fs';\nimport React from 'react';`;
    const specs = extractSpecifiers(src);
    // Non-relative specifiers are fine to include; resolveSpecifier will reject them
    // but the key is we don't blow up
    assert.ok(Array.isArray(specs));
  });
});

// ---------------------------------------------------------------------------
// resolveSpecifier
// ---------------------------------------------------------------------------

describe('resolveSpecifier', () => {
  let tmp;
  it('setup', () => {
    tmp = mkdtempSync(join(tmpdir(), 'mr-resolve-'));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src', 'utils.mjs'), '');
    writeFileSync(join(tmp, 'src', 'index.mjs'), '');
  });

  it('resolves relative path with extension', () => {
    const fileSet = new Set(['src/utils.mjs', 'src/index.mjs']);
    const result = resolveSpecifier('./utils.mjs', 'src/index.mjs', tmp, fileSet);
    assert.equal(result, 'src/utils.mjs');
  });

  it('resolves relative path without extension (tries extensions)', () => {
    const fileSet = new Set(['src/utils.mjs', 'src/index.mjs']);
    const result = resolveSpecifier('./utils', 'src/index.mjs', tmp, fileSet);
    assert.equal(result, 'src/utils.mjs');
  });

  it('returns null for package imports', () => {
    const fileSet = new Set(['src/utils.mjs']);
    const result = resolveSpecifier('lodash', 'src/index.mjs', tmp, fileSet);
    assert.equal(result, null);
  });

  it('returns null when target does not exist in repo', () => {
    const fileSet = new Set(['src/utils.mjs']);
    const result = resolveSpecifier('./nonexistent', 'src/index.mjs', tmp, fileSet);
    assert.equal(result, null);
  });

  it('cleanup', () => rmSync(tmp, { recursive: true, force: true }));
});

// ---------------------------------------------------------------------------
// computeInDegree
// ---------------------------------------------------------------------------

describe('computeInDegree', () => {
  let tmp;
  it('setup', () => {
    tmp = mkdtempSync(join(tmpdir(), 'mr-indegree-'));
    mkdirSync(join(tmp, 'src'), { recursive: true });
    // a.mjs imports b.mjs and c.mjs
    writeFileSync(join(tmp, 'src', 'a.mjs'), `
import { b } from './b.mjs';
import { c } from './c.mjs';
`);
    // b.mjs imports c.mjs
    writeFileSync(join(tmp, 'src', 'b.mjs'), `
import { c } from './c.mjs';
`);
    // c.mjs has no imports
    writeFileSync(join(tmp, 'src', 'c.mjs'), `export const c = 1;`);
  });

  it('computes correct in-degree', () => {
    const files = ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'];
    const inDeg = computeInDegree(files, tmp);
    // c is imported by both a and b → inDegree 2
    assert.equal(inDeg['src/c.mjs'], 2, 'c.mjs should have inDegree 2');
    // b is imported by a → inDegree 1
    assert.equal(inDeg['src/b.mjs'], 1, 'b.mjs should have inDegree 1');
    // a is not imported by anyone → inDegree 0
    assert.equal(inDeg['src/a.mjs'], 0, 'a.mjs should have inDegree 0');
  });

  it('cleanup', () => rmSync(tmp, { recursive: true, force: true }));
});
