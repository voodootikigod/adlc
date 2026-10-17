import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { runMutant } from '../lib/runner.mjs';

test('an undetermined mutant carries the syntax checker cause', (t) => {
  const dir = tmp(t, 'hollow-syntax-detail-');
  const file = join(dir, 'target.ts');
  const original = 'export const answer: number = 42;\n';
  const mutated = 'export const answer: number = 43;\n';
  writeFileSync(file, original);

  const result = runMutant(file, original, mutated, 'node -e 0', 1000, dir);

  assert.equal(result.undetermined, true);
  assert.match(result.reason, /typescript/i);
  assert.equal(readFileSync(file, 'utf8'), original);
});
