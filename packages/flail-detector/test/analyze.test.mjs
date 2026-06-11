// test/analyze.test.mjs — integration tests for the analyze() function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../lib/analyze.mjs';

const DEFAULT_OPTS = {
  scopes: [],
  maxRepeat: 2,
  maxBytes: null,
};

test('analyze: clean log returns clean verdict', () => {
  const lines = ['Build started', 'Compiling modules...', 'Done in 2.3s'];
  const result = analyze({ lines, bytes: 100, ...DEFAULT_OPTS });
  assert.equal(result.verdict, 'clean');
  assert.equal(result.signals.length, 0);
  assert.equal(result.recommendation, undefined);
});

test('analyze: repeated error triggers flail verdict', () => {
  const lines = [
    'Error: cannot connect to database',
    'Error: cannot connect to database',
  ];
  const result = analyze({ lines, bytes: 100, ...DEFAULT_OPTS });
  assert.equal(result.verdict, 'flail');
  assert.ok(result.signals.some((s) => s.type === 'repeated-error'));
  assert.ok(result.recommendation);
  assert.match(result.recommendation, /Kill the session/);
});

test('analyze: repeated error recommendation includes signatures', () => {
  const lines = [
    'ENOENT: no such file /foo/bar.js',
    'ENOENT: no such file /baz/qux.ts',
  ];
  const result = analyze({ lines, bytes: 100, ...DEFAULT_OPTS });
  assert.equal(result.verdict, 'flail');
  assert.match(result.recommendation, /dead-ends/);
});

test('analyze: scope violation triggers flail', () => {
  const lines = ['Writing /etc/passwd'];
  const result = analyze({
    lines, bytes: 100,
    scopes: ['src/**'],
    maxRepeat: 2,
    maxBytes: null,
  });
  assert.equal(result.verdict, 'flail');
  assert.ok(result.signals.some((s) => s.type === 'scope-violation'));
});

test('analyze: edit churn triggers flail', () => {
  const lines = [
    'Writing src/foo.js',
    'Editing src/foo.js',
    'Writing src/foo.js',
  ];
  const result = analyze({ lines, bytes: 100, ...DEFAULT_OPTS });
  assert.equal(result.verdict, 'flail');
  assert.ok(result.signals.some((s) => s.type === 'edit-churn'));
});

test('analyze: size exceeded triggers flail', () => {
  const lines = ['Build started'];
  const result = analyze({
    lines, bytes: 500,
    scopes: [],
    maxRepeat: 2,
    maxBytes: 100,
  });
  assert.equal(result.verdict, 'flail');
  assert.ok(result.signals.some((s) => s.type === 'size'));
});

test('analyze: size not exceeded stays clean', () => {
  const lines = ['Build started'];
  const result = analyze({
    lines, bytes: 50,
    scopes: [],
    maxRepeat: 2,
    maxBytes: 100,
  });
  assert.equal(result.verdict, 'clean');
});

test('analyze: multiple signals reported together', () => {
  const lines = [
    'Error: cannot connect to database',
    'Error: cannot connect to database',
    'Writing /etc/shadow',
    'Writing src/foo.js',
    'Editing src/foo.js',
    'Writing src/foo.js',
  ];
  const result = analyze({
    lines,
    bytes: 300,
    scopes: ['src/**'],
    maxRepeat: 2,
    maxBytes: null,
  });
  assert.equal(result.verdict, 'flail');
  const types = result.signals.map((s) => s.type);
  assert.ok(types.includes('repeated-error'));
  assert.ok(types.includes('scope-violation'));
  assert.ok(types.includes('edit-churn'));
});

test('analyze: result always includes bytes field', () => {
  const result = analyze({ lines: ['ok'], bytes: 42, ...DEFAULT_OPTS });
  assert.equal(result.bytes, 42);
});
