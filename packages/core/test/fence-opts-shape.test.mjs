// fence() fails closed on a malformed options argument: a positional bias
// string or a misspelled key must throw, not silently keep tail truncation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fence } from '../lib/text.mjs';

const BODY = 'OPENING ' + 'y'.repeat(100) + ' TRAILING';

for (const [name, opts] of [
  ['positional string', 'head'],
  ['array', ['head']],
  ['number', 7],
  ['boolean', true],
  ['function', () => 'head'],
  ['misspelled key', { biais: 'head' }],
  ['wrong-case key', { Bias: 'head' }],
  ['extra key beside bias', { bias: 'head', cap: 10 }],
]) {
  test(`fence rejects a malformed opts shape: ${name}`, () => {
    assert.throws(() => fence('S', BODY, 50, opts), /fence: /);
  });
}

test('fence accepts every well-formed opts shape', () => {
  assert.match(fence('S', BODY, 50), /TRAILING/);
  assert.match(fence('S', BODY, 50, undefined), /TRAILING/);
  assert.match(fence('S', BODY, 50, null), /TRAILING/);
  assert.match(fence('S', BODY, 50, {}), /TRAILING/);
  assert.match(fence('S', BODY, 50, { bias: 'tail' }), /TRAILING/);
  const head = fence('S', BODY, 50, { bias: 'head' });
  assert.match(head, /OPENING/);
  assert.doesNotMatch(head, /TRAILING/);
  assert.match(fence('S', BODY, 50, Object.assign(Object.create(null), { bias: 'head' })), /OPENING/);
});
