// entry-shape.test.mjs — the module is an OpenCode v2 plugin: the host requires a
// default export `{ id, setup(ctx) }` ("Plugin must export a default definition
// with an id and an effect or setup function").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mod from '../index.mjs';

test('default export is the v2 definition { id: "adlc", setup }', () => {
  assert.equal(typeof mod.default, 'object');
  assert.equal(mod.default.id, 'adlc');
  assert.equal(typeof mod.default.setup, 'function');
});

test('the v1 factory export is gone: the module exports exactly the v2 surface', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['RAIL_NOTICE_TOOLS', 'default', 'optionsToEnv']);
});

test('the entrypoint imports nothing from the host at load', () => {
  const src = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from ['"]@opencode/);
  assert.doesNotMatch(src, /import\(['"]@opencode/);
});
