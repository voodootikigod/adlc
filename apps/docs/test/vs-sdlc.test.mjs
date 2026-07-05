import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VS_SDLC_ROWS } from '../lib/vs-sdlc.mjs';

test('at least five comparison rows, unique dimensions, all cells filled', () => {
  assert.ok(VS_SDLC_ROWS.length >= 5);
  const dims = VS_SDLC_ROWS.map((r) => r.dimension);
  assert.equal(new Set(dims).size, dims.length, 'duplicate dimension');
  for (const r of VS_SDLC_ROWS) {
    assert.ok(r.dimension.length > 0 && r.sdlc.length > 0 && r.adlc.length > 0);
  }
});
