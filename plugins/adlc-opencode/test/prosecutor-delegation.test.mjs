// prosecutor-delegation.test.mjs — T17 AC3: the plugin's prosecutor surface
// must BE @adlc/core's prosecutor surface (reference equality, not value
// equality), so a reintroduced local copy of the convergence logic — even a
// byte-identical one — fails this test. NEW file: the pre-existing
// prosecutor.test.mjs is a frozen characterization rail and stays untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@adlc/core';
import * as shim from '../lib/prosecutor.mjs';

const SYMBOLS = [
  'LENSES', 'VERIFIER', 'ALL_AGENTS',
  'findingKey', 'dedupeFindings', 'survivesVerification', 'shouldContinue',
];

test('lib/prosecutor.mjs re-exports are reference-identical to @adlc/core', () => {
  for (const name of SYMBOLS) {
    assert.ok(name in shim, `${name} exported by the shim`);
    assert.strictEqual(
      shim[name],
      core[name],
      `${name} must be the @adlc/core binding itself, not a local copy`,
    );
  }
});
