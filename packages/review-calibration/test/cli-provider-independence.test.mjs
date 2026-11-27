import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProviderIndependence } from '../lib/judge.mjs';

test('checkProviderIndependence maps claude-cli, codex, codex-cli, and agy to canonical vendor families', () => {
  assert.equal(checkProviderIndependence('claude-cli', 'anthropic').same, true);
  assert.equal(checkProviderIndependence('claude-cli', 'claude').same, true);
  assert.equal(checkProviderIndependence('codex', 'openai').same, true);
  assert.equal(checkProviderIndependence('codex-cli', 'openai').same, true);
  assert.equal(checkProviderIndependence('codex-cli', 'gpt').same, true);
  assert.equal(checkProviderIndependence('agy', 'gemini').same, true);
  assert.equal(checkProviderIndependence('agy', 'google').same, true);
  assert.equal(checkProviderIndependence('claude-cli', 'codex-cli').same, false);
  assert.equal(checkProviderIndependence('codex-cli', 'agy').same, false);
});
