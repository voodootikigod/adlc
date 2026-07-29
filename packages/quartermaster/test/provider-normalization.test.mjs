// Drift guard for §4b rule 7 / §6.
//
// `lib/provider.mjs` re-states the provider normal form because the authority —
// `prosecute/lib/cross-model.mjs`'s `normalizeProvider` — is module-private and
// `packages/prosecute` is a rail for this ticket. A re-statement that nobody
// checks is just a copy waiting to diverge, and the divergence would be silent
// AND load-bearing: a registry value this package calls "normalized" that the
// attestation verifier folds differently means two seats that look distinct here
// are the same family there.
//
// So: drive prosecute's EXPORTED `scopeObservedEntriesToAuthor` (which compares
// through the private authority) over a variant table and assert it agrees with
// this package's `normalizeProviderName` on every row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeObservedEntriesToAuthor } from '../../prosecute/lib/cross-model.mjs';
import { normalizeProviderName, isNormalizedProvider } from '../lib/provider.mjs';

/** Every pair the two implementations must agree on — same family or not. */
const VARIANTS = [
  'openai',
  'OpenAI',
  'OPENAI',
  'open ai',
  'openai ',
  ' openai',
  '\topenai\n',
  'anthropic',
  'Anthropic',
  'ANTHROPIC',
  'zai',
  'ZAI',
  'moonshot',
  'Moon Shot',
  'moonshot',
];

/** Does prosecute consider these two provider strings the same family? */
function prosecuteSaysSame(a, b) {
  const entries = [{ data: { authorProvider: a } }];
  return scopeObservedEntriesToAuthor(entries, b).length === 1;
}

test('this package agrees with prosecute on every provider-variant pair', () => {
  for (const a of VARIANTS) {
    for (const b of VARIANTS) {
      const ours = normalizeProviderName(a) === normalizeProviderName(b);
      const theirs = prosecuteSaysSame(a, b);
      assert.equal(
        ours,
        theirs,
        `disagreement on (${JSON.stringify(a)}, ${JSON.stringify(b)}): ` +
          `quartermaster says ${ours ? 'same' : 'distinct'}, prosecute says ${theirs ? 'same' : 'distinct'}. ` +
          'The provider normal form has drifted — reconcile lib/provider.mjs with cross-model.mjs#normalizeProvider.'
      );
    }
  }
});

test('normalizing any variant produces a value this package accepts as normalized', () => {
  for (const variant of VARIANTS) {
    assert.equal(isNormalizedProvider(normalizeProviderName(variant)), true, `normalized form of ${JSON.stringify(variant)}`);
  }
});

test('a merely-normalizable value is REJECTED rather than silently folded', () => {
  // Rule 7 wants the operator to see the typo. Accepting "OpenAI" here would
  // store a value that every downstream comparison folds anyway — invisible drift.
  assert.equal(isNormalizedProvider('OpenAI'), false);
  assert.equal(isNormalizedProvider('open ai'), false);
  assert.equal(isNormalizedProvider('anthropic '), false);
  assert.equal(isNormalizedProvider('openai'), true);
});

test('non-strings and empties are never normalized providers', () => {
  for (const bad of [undefined, null, 42, {}, [], '']) {
    assert.equal(isNormalizedProvider(bad), false, `${JSON.stringify(bad)}`);
  }
});
