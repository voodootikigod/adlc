import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADLC_GITIGNORE_LINES } from '../lib/gitignore-defaults.mjs';

test('ADLC_GITIGNORE_LINES pins its exact, frozen contents', () => {
  assert.deepEqual(ADLC_GITIGNORE_LINES, [
    '.adlc/*',
    '!.adlc/config.json',
    '!.adlc/tickets.json',
    '!.adlc/tickets/',
    '!.adlc/tickets/**',
    '!.adlc/ticket-archive/',
    '!.adlc/ticket-archive/**',
    '!.adlc/specs/',
  ]);
  assert.ok(Object.isFrozen(ADLC_GITIGNORE_LINES));
});
