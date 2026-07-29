// Provider-string normal form (§4b rule 7, §6).
//
// The AUTHORITY for provider identity is `prosecute/lib/cross-model.mjs`'s
// module-private `normalizeProvider`: NFKC-fold, strip ALL whitespace, case-fold.
// That function decides whether two attestation seats are the same family, and
// §4b rule 7 requires `modelProviders` values to be *already* in that normal
// form — so a registry can never introduce a variant ("OpenAI", "open ai") that
// compares distinct here and identical there, or vice versa.
//
// This module re-states the rule rather than importing it, because the authority
// is not exported and `packages/prosecute` is a RAIL for this ticket. The copy is
// guarded, not trusted: `test/provider-normalization.test.mjs` drives prosecute's
// exported `scopeObservedEntriesToAuthor` over a variant table and asserts it
// agrees with `normalizeProviderName` on every row, so a change to the authority
// fails this package's suite instead of silently diverging.

/** The normal form provider strings are compared in. Mirrors the §6 authority. */
export function normalizeProviderName(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, '').toLowerCase() : '';
}

/**
 * True if `value` is a non-empty string ALREADY in normal form.
 *
 * Rejecting a merely-normalizable value (rather than normalizing it silently) is
 * the fail-closed reading of rule 7: the registry is operator-authored, and an
 * un-normalized entry is a typo the operator should see, not one the loader
 * should paper over.
 */
export function isNormalizedProvider(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return normalizeProviderName(value) === value;
}
