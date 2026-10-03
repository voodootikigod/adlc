// Quota validation accepts only plain JSON objects, with core's isPlainObject
// semantics: a class instance carrying the right fields is not a limits entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLimitEntry } from '../lib/quota.mjs';

class LimitLike {
  constructor() {
    this.kind = 'weekly';
    this.percent = 40;
  }
}

test('validateLimitEntry rejects a non-plain object even when its fields are valid', () => {
  const result = validateLimitEntry(new LimitLike());
  assert.equal(result.ok, false);
  assert.match(result.detail, /not an object/);
});

test('validateLimitEntry still accepts the same fields as a plain object', () => {
  assert.deepEqual(validateLimitEntry({ kind: 'weekly', percent: 40 }), { ok: true, family: null, percent: 40 });
});
