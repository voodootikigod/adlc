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
 * `docs/ci/rails-guard.yml` and `scripts/rails-guard-ci.mjs` are ADLC-repo paths that a
 * downstream repo will not have. They stay in the default set anyway: freezing a path
 * that does not exist costs nothing (it simply never appears in a diff), and dropping
 * them would silently narrow the frozen set for any repo that vendored those files from
 * an earlier template. Narrowing a security boundary is not a refactor.
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
