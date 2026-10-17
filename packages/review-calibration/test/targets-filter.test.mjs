// packages/review-calibration/test/targets-filter.test.mjs
// Unit tests for filterCodeFiles, anchored TEST_PATH_RE, and positive CODE_EXT_RE

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterCodeFiles,
  TEST_PATH_RE,
  CODE_EXT_RE,
  isTestFile,
} from '../lib/targets.mjs';

describe('targets.mjs: filterCodeFiles & anchored predicates', () => {
  it('retains production code files whose package or module contains test/spec substrings', () => {
    const retained = [
      'packages/hollow-test/lib/run.mjs',
      'packages/spec-lint/lib/lint.mjs',
      'packages/gate-manifest/lib/attest.mjs',
    ];
    assert.deepEqual(filterCodeFiles(retained), retained);
  });

  it('excludes test files, spec files, and non-code/extensionless files', () => {
    const excluded = [
      'packages/core/test/foo.test.mjs',
      'src/foo.spec.ts',
      'LICENSE',
      'README.md',
    ];
    assert.deepEqual(filterCodeFiles(excluded), []);
  });

  it('correctly filters a mixed list preserving expected order', () => {
    const mixed = [
      'packages/hollow-test/lib/run.mjs',
      'packages/core/test/foo.test.mjs',
      'packages/spec-lint/lib/lint.mjs',
      'src/foo.spec.ts',
      'LICENSE',
      'packages/gate-manifest/lib/attest.mjs',
      'README.md',
    ];
    assert.deepEqual(filterCodeFiles(mixed), [
      'packages/hollow-test/lib/run.mjs',
      'packages/spec-lint/lib/lint.mjs',
      'packages/gate-manifest/lib/attest.mjs',
    ]);
  });

  it('excludes extensionless files like LICENSE, CODEOWNERS, Dockerfile, and .gitignore', () => {
    const nonCode = ['LICENSE', 'CODEOWNERS', 'Dockerfile', '.gitignore', '.nvmrc', 'Makefile'];
    assert.deepEqual(filterCodeFiles(nonCode), []);
  });

  it('CODE_EXT_RE matches valid code extensions and rejects non-code extensions', () => {
    const valid = [
      'file.mjs', 'file.cjs', 'file.js',
      'file.ts', 'file.mts', 'file.cts',
      'file.jsx', 'file.tsx', 'file.py',
    ];
    for (const f of valid) {
      assert.ok(CODE_EXT_RE.test(f), `expected ${f} to match CODE_EXT_RE`);
    }

    const invalid = [
      'LICENSE', 'file.md', 'file.json', 'file.yaml', 'file.yml',
      'file.lock', 'file.txt', 'file.toml', 'file.snap', 'file.css',
      'file.svg', 'file.png',
    ];
    for (const f of invalid) {
      assert.equal(CODE_EXT_RE.test(f), false, `expected ${f} to not match CODE_EXT_RE`);
    }
  });

  it('isTestFile / TEST_PATH_RE correctly identifies test files while preserving production files', () => {
    assert.equal(isTestFile('packages/core/test/foo.test.mjs'), true);
    assert.equal(isTestFile('src/foo.spec.ts'), true);
    assert.equal(isTestFile('test/unit.js'), true);
    assert.equal(isTestFile('tests/integration.js'), true);
    assert.equal(isTestFile('spec/runner.js'), true);
    assert.equal(isTestFile('specs/runner.js'), true);
    assert.equal(isTestFile('__tests__/suite.js'), true);
    assert.equal(isTestFile('src/test-utils.js'), true);
    assert.equal(isTestFile('src/utils-test.js'), true);
    assert.equal(isTestFile('src/utils_test.js'), true);

    // Production files with test/spec in directory or filename must not be excluded
    assert.equal(isTestFile('packages/hollow-test/lib/run.mjs'), false);
    assert.equal(isTestFile('packages/spec-lint/lib/lint.mjs'), false);
    assert.equal(isTestFile('packages/gate-manifest/lib/attest.mjs'), false);
    assert.equal(isTestFile('packages/review-calibration/lib/targets.mjs'), false);

    // Windows backslash paths
    assert.equal(isTestFile('packages\\core\\test\\foo.test.mjs'), true);
    assert.equal(isTestFile('packages\\hollow-test\\lib\\run.mjs'), false);
  });
});

