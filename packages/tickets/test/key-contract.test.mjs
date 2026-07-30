// key-contract.test.mjs — the shared manifest-key parameter contract
// (T-01KYQMPBK8TKJKNRQABD8FXC61, spec .adlc/specs/manifest-key-hermeticity.md Layer 2).
//
// One validation helper owns what a `key` parameter may be, and it lives HERE, in the
// leaf package (@adlc/tickets has no deps; gate-manifest -> core -> tickets already
// exists, so everything above can import this without a cycle, while a
// tickets -> gate-manifest import is forbidden — it would close the loop the tickets
// package deliberately avoids today).
//
// The contract (P1: a set key never changes the outcome of an operation that did not
// explicitly receive it):
//   non-empty string -> the key;
//   null             -> "no key, deterministically";
//   undefined        -> programming error, THROWS (omission must never fall back to env);
//   ''               -> THROWS (a zero-length HMAC key is publicly guessable, and ''
//                       means "deliberate fail-closed" everywhere else in this system);
//   any non-string   -> THROWS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateKeyParam } from '../lib/key-contract.mjs';

test('a non-empty string passes through unchanged', () => {
  assert.equal(validateKeyParam('test-signing-key'), 'test-signing-key');
});

test('null means "no key, deterministically" and passes through', () => {
  assert.equal(validateKeyParam(null), null);
});

test('undefined (omission) throws — it must never fall back to the environment', () => {
  process.env.ADLC_MANIFEST_KEY = 'ambient-key-that-must-not-be-consulted';
  try {
    assert.throws(() => validateKeyParam(undefined), /key/i);
    // The spread-with-undefined footgun is the same call shape:
    const opts = { key: undefined };
    assert.throws(() => validateKeyParam(opts.key), /key/i);
  } finally {
    delete process.env.ADLC_MANIFEST_KEY;
  }
});

test('the empty string throws — it must never reach the HMAC', () => {
  assert.throws(() => validateKeyParam(''), /key/i);
});

test('non-strings throw', () => {
  for (const bad of [0, 42, true, false, {}, [], Symbol('k'), () => {}]) {
    assert.throws(() => validateKeyParam(bad), /key/i, `expected throw for ${String(bad)}`);
  }
});

test('the error names the accepted forms so a caller can self-correct', () => {
  let message = '';
  try { validateKeyParam(undefined); } catch (err) { message = err.message; }
  assert.match(message, /null/, 'the error must name null as the explicit no-key form');
});
