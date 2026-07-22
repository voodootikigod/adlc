// resolve-expected-model.test.mjs — exercises resolveExpectedModel's REAL
// implementation (detectProvider + resolveModel from @adlc/core), not an
// injected stand-in. Every other test in this package injects a fake
// resolveModelFn into checkAll, which is correct for testing checkAll's own
// logic in isolation — but it meant resolveExpectedModel's actual body had
// zero coverage (mutation-gate CI finding on PR #291: replacing its body
// with `return null` survived, which would silently disable caching for
// every ticket whenever a provider WAS configured).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExpectedModel } from '../lib/gate.mjs';

test('resolveExpectedModel returns the cheap-tier model id when an anthropic key is configured', () => {
  const model = resolveExpectedModel('cheap', { ANTHROPIC_API_KEY: 'test-key' });
  assert.equal(model, 'claude-haiku-4-5');
});

test('resolveExpectedModel returns the mid-tier model id for tier "mid"', () => {
  const model = resolveExpectedModel('mid', { ANTHROPIC_API_KEY: 'test-key' });
  assert.equal(model, 'claude-sonnet-4-6');
});

test('resolveExpectedModel respects an ADLC_MODEL_CHEAP override — the same override that must invalidate the cache', () => {
  const model = resolveExpectedModel('cheap', { ANTHROPIC_API_KEY: 'test-key', ADLC_MODEL_CHEAP: 'claude-3-5-haiku' });
  assert.equal(model, 'claude-3-5-haiku');
});

test('resolveExpectedModel returns null when no provider is configured (nothing to cache-key on)', () => {
  const model = resolveExpectedModel('cheap', {});
  assert.equal(model, null);
});

test('resolveExpectedModel picks the correct model for a non-anthropic provider (openai)', () => {
  const model = resolveExpectedModel('cheap', { OPENAI_API_KEY: 'test-key' });
  assert.equal(model, 'gpt-5-mini');
});
