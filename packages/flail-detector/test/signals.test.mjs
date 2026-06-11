// test/signals.test.mjs — unit tests for each signal detector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeError,
  extractPath,
  detectRepeatedErrors,
  detectScopeViolations,
  detectEditChurn,
  detectSizeExceeded,
} from '../lib/signals.mjs';

// ---------------------------------------------------------------------------
// normalizeError
// ---------------------------------------------------------------------------

test('normalizeError: lowercases and strips digits', () => {
  const a = normalizeError('Error: line 42 failed');
  const b = normalizeError('Error: line 99 failed');
  assert.equal(a, b, 'different line numbers should normalize to same signature');
});

test('normalizeError: strips hex literals', () => {
  const a = normalizeError('Error at 0xDEADBEEF: segfault');
  const b = normalizeError('Error at 0x1234abcd: segfault');
  assert.equal(a, b);
});

test('normalizeError: strips quoted strings', () => {
  const a = normalizeError('Cannot find module "lodash"');
  const b = normalizeError('Cannot find module "express"');
  assert.equal(a, b);
});

test('normalizeError: strips absolute paths', () => {
  const a = normalizeError('ENOENT: no such file /home/alice/project/src/foo.js');
  const b = normalizeError('ENOENT: no such file /home/bob/workspace/bar.ts');
  assert.equal(a, b);
});

test('normalizeError: collapses whitespace', () => {
  const a = normalizeError('Error:   too   many   spaces');
  const b = normalizeError('Error: too many spaces');
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// extractPath
// ---------------------------------------------------------------------------

test('extractPath: extracts Writing path', () => {
  assert.equal(extractPath('Writing src/index.js'), 'src/index.js');
});

test('extractPath: extracts Editing path', () => {
  assert.equal(extractPath('Editing lib/utils.mjs'), 'lib/utils.mjs');
});

test('extractPath: extracts Created path', () => {
  assert.equal(extractPath('Created test/foo.test.js'), 'test/foo.test.js');
});

test('extractPath: extracts file_path from JSON-like log line', () => {
  assert.equal(extractPath('"file_path":"src/app.ts"'), 'src/app.ts');
});

test('extractPath: returns null for non-matching line', () => {
  assert.equal(extractPath('Error: something went wrong'), null);
});

// ---------------------------------------------------------------------------
// detectRepeatedErrors
// ---------------------------------------------------------------------------

test('detectRepeatedErrors: returns empty when no errors', () => {
  const lines = ['Build started', 'Compiling...', 'Done.'];
  assert.deepEqual(detectRepeatedErrors(lines, 2), []);
});

test('detectRepeatedErrors: returns empty when error appears < maxRepeat times', () => {
  const lines = ['Error: cannot connect to database'];
  assert.deepEqual(detectRepeatedErrors(lines, 2), []);
});

test('detectRepeatedErrors: triggers on exact maxRepeat', () => {
  const lines = [
    'Error: cannot connect to database',
    'Error: cannot connect to database',
  ];
  const result = detectRepeatedErrors(lines, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].count, 2);
});

test('detectRepeatedErrors: normalizes variants of same error to same signature', () => {
  const lines = [
    'Error: cannot find module "lodash" at line 42',
    'Error: cannot find module "express" at line 99',
    'Error: cannot find module "react" at line 5',
  ];
  const result = detectRepeatedErrors(lines, 2);
  // All three normalize to same signature → triggers at maxRepeat=2
  assert.equal(result.length, 1);
  assert.equal(result[0].count, 3);
});

test('detectRepeatedErrors: ENOENT variants collapse', () => {
  const lines = [
    'ENOENT: no such file or directory /home/user/proj/foo.js',
    'ENOENT: no such file or directory /tmp/bar.json',
  ];
  const result = detectRepeatedErrors(lines, 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].count, 2);
});

test('detectRepeatedErrors: maxRepeat=3 does not trigger at count=2', () => {
  const lines = [
    'Error: failed to build',
    'Error: failed to build',
  ];
  assert.deepEqual(detectRepeatedErrors(lines, 3), []);
});

// ---------------------------------------------------------------------------
// detectScopeViolations
// ---------------------------------------------------------------------------

test('detectScopeViolations: returns empty when no scopes given', () => {
  const lines = ['Writing /etc/passwd'];
  assert.deepEqual(detectScopeViolations(lines, []), []);
});

test('detectScopeViolations: in-scope path does not trigger', () => {
  const lines = ['Writing src/index.js'];
  assert.deepEqual(detectScopeViolations(lines, ['src/**']), []);
});

test('detectScopeViolations: out-of-scope path triggers', () => {
  const lines = ['Writing /etc/shadow'];
  const result = detectScopeViolations(lines, ['src/**']);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, '/etc/shadow');
});

test('detectScopeViolations: multiple scopes — in any is fine', () => {
  const lines = ['Editing test/foo.test.js'];
  assert.deepEqual(detectScopeViolations(lines, ['src/**', 'test/**']), []);
});

test('detectScopeViolations: lines without paths are ignored', () => {
  const lines = ['Error: something failed', 'Build started'];
  assert.deepEqual(detectScopeViolations(lines, ['src/**']), []);
});

// ---------------------------------------------------------------------------
// detectEditChurn
// ---------------------------------------------------------------------------

test('detectEditChurn: returns empty when no paths appear >= 3 times', () => {
  const lines = [
    'Writing src/foo.js',
    'Writing src/bar.js',
    'Writing src/foo.js',
  ];
  assert.deepEqual(detectEditChurn(lines), []);
});

test('detectEditChurn: triggers at exactly 3 occurrences', () => {
  const lines = [
    'Writing src/foo.js',
    'Editing src/foo.js',
    'Writing src/foo.js',
  ];
  const result = detectEditChurn(lines);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'src/foo.js');
  assert.equal(result[0].count, 3);
});

test('detectEditChurn: only reports paths with >= 3 edits', () => {
  const lines = [
    'Writing src/a.js',
    'Writing src/a.js',
    'Writing src/a.js',
    'Writing src/b.js',
    'Writing src/b.js',
  ];
  const result = detectEditChurn(lines);
  assert.equal(result.length, 1);
  assert.equal(result[0].path, 'src/a.js');
});

// ---------------------------------------------------------------------------
// detectSizeExceeded
// ---------------------------------------------------------------------------

test('detectSizeExceeded: returns false when maxBytes is null', () => {
  assert.equal(detectSizeExceeded(1000000, null), false);
});

test('detectSizeExceeded: returns false when bytes <= maxBytes', () => {
  assert.equal(detectSizeExceeded(100, 200), false);
  assert.equal(detectSizeExceeded(200, 200), false);
});

test('detectSizeExceeded: returns true when bytes > maxBytes', () => {
  assert.equal(detectSizeExceeded(201, 200), true);
});
