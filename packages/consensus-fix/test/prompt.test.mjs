/**
 * Tests for prompt building and tail utility.
 * Pure — no I/O.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tail, buildPrompt } from '../lib/prompt.mjs';

test('tail returns the string unchanged when within limit', () => {
  assert.equal(tail('hello', 100), 'hello');
});

test('tail truncates to last maxChars characters', () => {
  const long = 'a'.repeat(5000);
  const result = tail(long, 4000);
  assert.equal(result.length, 4000);
  assert.equal(result, 'a'.repeat(4000));
});

test('tail with default 4000 chars', () => {
  const long = 'x'.repeat(6000);
  const result = tail(long);
  assert.equal(result.length, 4000);
});

test('buildPrompt includes test command', () => {
  const prompt = buildPrompt({
    testCmd: 'node --test test/foo.test.mjs',
    testOutput: 'Error: assertion failed',
    snapshot: { 'src/foo.mjs': 'export const x = 1;' },
  });
  assert.ok(prompt.includes('node --test test/foo.test.mjs'));
});

test('buildPrompt includes test output', () => {
  const output = 'Error: assertion failed at line 42';
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: output,
    snapshot: { 'a.mjs': 'code' },
  });
  assert.ok(prompt.includes(output));
});

test('buildPrompt includes file name and content', () => {
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: 'fail',
    snapshot: {
      'src/util.mjs': 'export function add(a, b) { return a - b; }',
    },
  });
  assert.ok(prompt.includes('src/util.mjs'));
  assert.ok(prompt.includes('export function add(a, b) { return a - b; }'));
});

test('buildPrompt includes JSON output format instruction', () => {
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: 'fail',
    snapshot: { 'a.mjs': 'code' },
  });
  assert.ok(prompt.includes('"changes"'));
  assert.ok(prompt.includes('JSON'));
});

test('buildPrompt tails long test output to 4000 chars', () => {
  const longOutput = 'line\n'.repeat(2000); // ~10000 chars
  const prompt = buildPrompt({
    testCmd: 'npm test',
    testOutput: longOutput,
    snapshot: { 'a.mjs': 'code' },
  });
  // The output in the prompt should be no more than 4000 chars of test output.
  // We find the section between the output code fences and verify.
  const match = prompt.match(/Test output[\s\S]*?```\n([\s\S]*?)```/);
  assert.ok(match, 'should have test output section');
  assert.ok(match[1].length <= 4001, 'output section should be at most 4000 chars + newline');
});
