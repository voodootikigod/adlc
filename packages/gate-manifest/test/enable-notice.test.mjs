import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CI_COVERAGE_WARNING,
  SEGMENTATION_UNDETERMINED_WARNING,
} from '../lib/enable.mjs';

test('CI_COVERAGE_WARNING and SEGMENTATION_UNDETERMINED_WARNING preserve stable warning codes and describe segment chain CI validation accurately', () => {
  assert.strictEqual(CI_COVERAGE_WARNING.code, 'ci-cannot-guard-segments');
  assert.strictEqual(SEGMENTATION_UNDETERMINED_WARNING.code, 'segmentation-undetermined');

  for (const warning of [CI_COVERAGE_WARNING, SEGMENTATION_UNDETERMINED_WARNING]) {
    assert.match(warning.message, /rails-guard/);
    assert.match(warning.message, /packages\/rails-guard\/lib\/ci\/manifest\.mjs/);
    assert.match(warning.message, /\.adlc\/manifest\.d\/\*\.jsonl/);
    assert.match(warning.message, /\.adlc\/manifest\.jsonl/);
    assert.match(warning.message, /uncommitted|\.gitignore/i);
    assert.doesNotMatch(warning.message, /does not yet validate/i);
  }
});
