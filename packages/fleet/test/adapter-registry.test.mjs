import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter, ADAPTERS } from '../lib/adapters/index.mjs';

test('registry exposes all seven harness adapters (AC1)', () => {
  assert.deepEqual([...ADAPTERS].sort(), ['agy', 'claude-code', 'codex', 'copilot', 'cursor', 'opencode', 'pi']);
});

test('getAdapter returns a shaped adapter for each name', () => {
  for (const n of ADAPTERS) {
    const a = getAdapter(n);
    assert.equal(a.name, n, `${n}: name matches`);
    assert.equal(typeof a.pool, 'string');
    assert.equal(typeof a.dispatch, 'function');
  }
});

test('getAdapter FAILS CLOSED on an unknown name (never silent fallback) (AC1)', () => {
  assert.throws(() => getAdapter('nope'), /unknown fleet worker adapter: "nope"/);
  assert.throws(() => getAdapter('nope'), /Registered adapters:/);
});
