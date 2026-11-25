import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHooks } from '../../../scripts/build-hooks.mjs';

test('committed dist/hook-engine.bundle.mjs matches build-hooks compiler output', () => {
  const res = buildHooks({ check: true, write: false });
  assert.equal(res.ok, true, `hook-engine bundle drifted: ${res.drifted.join(', ')}`);
});
