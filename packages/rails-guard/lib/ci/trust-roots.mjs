// The immutable trust-root set: files that freeze once a repo is bootstrapped (#140).
//
// A trust root is a file whose contents decide what the gate ENFORCES. Editing one is
// not an ordinary code change, because a PR that can edit the enforcer can also edit
// away its own enforcement. So they are frozen unconditionally, and unfreezing goes
// through the #141 ceremony (label + non-author CODEOWNER approval) or the
// protected-base admin path.

/**
 * The set every repo gets, with no configuration.
 *
 * Deliberately generic — these are the paths the ADLC workflow template creates or
 * relies on in ANY repo that installs it. A repo whose enforcement surface is wider
 * declares the rest itself; see `resolveImmutableTrustRoots`.
 *
 * The ADLC-repo paths at the end (`docs/ci/rails-guard.yml`, `scripts/rails-guard-ci.mjs`,
 * and the gate's own sources) are in the DEFAULTS rather than supplied by a caller, and
 * that placement is load-bearing. They were briefly passed in via `--trust-root` from
 * `scripts/rails-guard-ci.mjs`, on the argument that the wrapper is itself a default trust
 * root so the list could not shrink. Cross-model review refuted it: that split let ONE PR
 * remove the wrapper's arguments AND drop the wrapper from this list, unprotecting both
 * enforcement sources in a single change. Keeping every gate source here means disarming
 * the gate requires editing a file this list already covers.
 *
 * The residual is irreducible and pre-existing: a same-repo pull_request runs the PR
 * BRANCH's gate, so a PR that edits THIS FILE runs its own edited list. Nothing in-repo
 * closes that — the un-forgeable backstop is branch protection requiring CODEOWNERS
 * review, which is what the ceremony ultimately rests on. What this placement buys is that
 * the hole needs one obvious edit to a frozen, reviewed file rather than a two-file
 * indirection that reads as ordinary plumbing.
 *
 * A downstream repo will not have the ADLC-specific paths. Freezing a path that does not
 * exist costs nothing — it simply never appears in a diff — and dropping them would
 * silently narrow the frozen set for any repo that vendored those files from an earlier
 * template. Narrowing a security boundary is not a refactor.
 */
export const DEFAULT_IMMUTABLE_TRUST_ROOTS = Object.freeze([
  '.adlc/config.json',
  '.adlc/admin.pub',
  '.adlc/tickets/.store.json',
  // The DEPLOYED workflow — the file that actually runs this gate in the consuming repo.
  '.github/workflows/adlc-rails-guard.yml',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  'docs/ci/rails-guard.yml',
  'scripts/rails-guard-ci.mjs',
  // The gate's own sources. `lib/ci/**` is a directory glob, not a file list, so a NEW
  // file added under it is frozen the moment it exists — a list would have to be
  // remembered, and not having to remember is the point of #140.
  'packages/rails-guard/lib/ci/**',
  'packages/rails-guard/bin/rails-guard-ci.mjs',
  'packages/rails-guard/lib/trust-root-authorization.mjs',
  // The enforcement bin the gate spawns to render the final verdict. The in-gate freeze
  // CANNOT be transitively complete: that bin delegates to packages/rails-guard/lib/**
  // (check.mjs -> rails.mjs / suppressions.mjs), which uses @adlc/tickets for the
  // base-vs-head comparisons. That engine rests on branch-protection CODEOWNERS review,
  // the same merge gate this whole ceremony rests on. (See #326.)
  'packages/rails-guard/bin/rails-guard.mjs',
]);

/**
 * Resolve the trust-root set for one gate run.
 *
 * @param {object} options
 * @param {string[]} [options.additional] repo-specific trust roots, supplied by the
 *   caller (`--trust-root`). The ADLC repo uses this for the enforcement sources that
 *   live in its own tree. It is safe for the list to arrive from the command line
 *   BECAUSE the wrapper that supplies it is itself a trust root in the default set: a
 *   PR cannot shrink the list without editing a frozen file and tripping the ceremony.
 * @param {boolean} [options.verifiedMigration] true when this run has already verified a
 *   legacy-to-directory ticket-store migration. The migration CREATES
 *   `.adlc/tickets/.store.json`, so freezing it would deny the very ceremony that was
 *   just proven valid. Every other trust root stays frozen through a migration.
 * @param {boolean} [options.bootstrapped] whether anything is frozen yet. Before a repo
 *   has either declared rails or a base config there is nothing to protect and no
 *   trust roots apply — an empty repo must not be told its files are frozen.
 * @returns {string[]} de-duplicated, order-preserving
 */
export function resolveImmutableTrustRoots({ additional = [], verifiedMigration = false, bootstrapped = true } = {}) {
  if (!bootstrapped) return [];
  const roots = DEFAULT_IMMUTABLE_TRUST_ROOTS
    .filter((path) => !(verifiedMigration && path === '.adlc/tickets/.store.json'))
    .concat(additional.filter((path) => typeof path === 'string' && path.trim()));
  return [...new Set(roots)];
}
