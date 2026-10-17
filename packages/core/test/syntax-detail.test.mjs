import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkSyntaxDetail } from '../index.mjs';
import { tmp } from '../lib/test-kit.mjs';

function write(dir, name, text) {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

test('an unavailable TypeScript checker explains the unknown verdict', (t) => {
  const dir = tmp(t, 'core-syntax-detail-no-ts-');
  const file = write(dir, 'a.ts', 'export const answer: number = 42;\n');

  const result = checkSyntaxDetail(file, dir);

  assert.equal(result.verdict, 'unknown');
  assert.match(result.detail, /typescript/i);
});

test('syntax verdicts have no failure detail', (t) => {
  const dir = tmp(t, 'core-syntax-detail-verdicts-');

  assert.deepEqual(
    checkSyntaxDetail(write(dir, 'valid.mjs', 'export const answer = 42;\n'), dir),
    { verdict: 'valid', detail: null },
  );
  assert.deepEqual(
    checkSyntaxDetail(write(dir, 'invalid.mjs', 'export const answer = (;\n'), dir),
    { verdict: 'invalid', detail: null },
  );
});

test('a checker spawn failure has a non-empty detail', (t) => {
  const dir = tmp(t, 'core-syntax-detail-spawn-');
  const file = write(dir, 'a.mjs', 'export const answer = 42;\n');

  const result = checkSyntaxDetail(file, dir, join(dir, 'no-such-node'));

  assert.equal(result.verdict, 'unknown');
  assert.equal(typeof result.detail, 'string');
  assert.ok(result.detail.length > 0);
});
