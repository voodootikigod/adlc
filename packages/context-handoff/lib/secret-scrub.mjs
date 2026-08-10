// Remove credentials from a process environment before it can reach code the
// project controls.
//
// An enforcing hook resolves its gate implementation by walking into the
// project's node_modules (handoff-resolve.mjs) and imports what it finds. That
// module executes in the hook's process and can read `process.env` directly, so
// a repository shipping a package named `@adlc/context-handoff` could read the
// manifest signing key — the trust anchor for every cross-model attestation and
// gate-manifest entry, and one that stays forgeable long after the repository is
// closed.
//
// Passing `manifestKey: null` into the gate does NOT close this: the value is
// still sitting in the environment the imported module inherits. The only thing
// that closes it is removing the value before the import happens.
//
// This does not close the OTHER half of that hole — project code can still be
// imported and return a permissive verdict. That needs a plugin-owned core; see
// the trust-root ticket. Scrubbing is the half that is irreversible if missed:
// a bypassed gate is a bad merge, a leaked key is a forged approval forever.

/**
 * Environment variables an enforcing hook must never expose to imported code.
 * Exact names, not a pattern: a regex over `*_KEY` would also strip innocuous
 * settings and make the failure look like a config bug instead of a scrub.
 */
export const HOOK_SECRET_ENV_VARS = Object.freeze([
  'ADLC_MANIFEST_KEY',
  'ADLC_ADMIN_KEY',
]);

/**
 * Delete every known credential from `env`, in place.
 *
 * In place because `process.env` is the thing the imported module reads; handing
 * back a filtered copy would leave the real environment untouched and read as
 * fixed. Returns the names actually removed so a caller can assert the scrub
 * happened rather than trusting that it did.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {readonly string[]} [names]
 * @returns {string[]} the variables that were present and are now gone
 */
export function scrubHookSecrets(env = process.env, names = HOOK_SECRET_ENV_VARS) {
  const removed = [];
  if (!env || typeof env !== 'object') return removed;
  for (const name of names) {
    if (env[name] === undefined) continue;
    delete env[name];
    removed.push(name);
  }
  return removed;
}
