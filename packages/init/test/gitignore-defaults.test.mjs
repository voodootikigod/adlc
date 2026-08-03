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
    '!.adlc/manifest.jsonl',
    '!.adlc/manifest.d/',
    '!.adlc/manifest.d/**',
    '.adlc/manifest.d/.lineage',
    '.adlc/manifest.d/*.lock',
    '.adlc/manifest.d/*.tmp-*',
  ]);
  assert.ok(Object.isFrozen(ADLC_GITIGNORE_LINES));
});

// Ordering, not just membership: gitignore is last-match-wins, so a
// re-ignore that precedes its negation is dead. The behavioral proof lives
// in gitignore-manifest.test.mjs (real `git check-ignore`); this pins the
// invariant at the constant so a reorder fails here too, with a clearer
// message than a check-ignore mismatch.
test('every negation precedes the re-ignores that must override it', () => {
  const idx = (line) => ADLC_GITIGNORE_LINES.indexOf(line);
  assert.ok(idx('.adlc/*') === 0, '.adlc/* must come first — nothing below it can be re-included otherwise');
  for (const reIgnore of ['.adlc/manifest.d/.lineage', '.adlc/manifest.d/*.lock']) {
    assert.ok(idx(reIgnore) > idx('!.adlc/manifest.d/**'), `${reIgnore} must follow the manifest.d negations to take effect`);
  }
});
