// Mutation seams (spec AC 1, AC 114, AC 121).
//
// Test-only fault injection: the spec-coverage gate proves test efficacy by
// injecting deterministic defects through documented seams. In production,
// state is held in module-private collections and sealed before dispatch.
// The CLI entry point calls sealSeams() at process start; once sealed, no seam
// can be activated, active() always evaluates to false, and enable() throws.

const known = new Set();
const activeSet = new Set();
let sealed = false;

/** The seams the foundation modules consult; other modules register their own. */
export const FOUNDATION_SEAMS = Object.freeze([
  'input.acceptAnything',        // grammar validators accept every value
  'spawn.noDeadline',            // the spawn wrapper never arms its deadline
  'spawn.shellTrue',             // the spawn wrapper records shell:true (argv safety)
  'redactor.disable',            // the redactor returns its input unchanged and claims ok
  'redactor.skipSecondPass',     // the residual-match check is skipped
  'quota.forceOk',               // the gate says ok regardless of the windows
  'quota.lenientSchema',         // malformed limits entries are skipped instead of refusing
  'quota.reuseStale',            // a stale sample is reused past the TTL
  'quota.noReserve',             // later starts are gated at the threshold, not threshold − reserve
  'lock.alwaysAcquire',          // a live lock is reclaimed anyway
  'lock.releaseAnyToken',        // release ignores the token
  'config.acceptAnyThreshold',   // thresholds above 50 are accepted
  'config.allowRaise',           // CLI may raise a lower-only key
  'config.honourRepoOperatorKeys', // repo config quotaThreshold is honoured
  'keys.leakKey',                // the manifest key is added to every child env
  'paths.allowLinkedWorktree',   // a linked worktree is accepted as REPO_ROOT
]);

/** Register seam names a module consults. Idempotent; returns the names. */
export function registerSeams(names) {
  for (const n of names) {
    if (typeof n !== 'string' || !/^[a-z][a-zA-Z0-9-]*\.[a-zA-Z][a-zA-Z0-9-]*$/.test(n)) throw new Error(`invalid seam name: ${n}`);
    known.add(n);
  }
  return names;
}
registerSeams(FOUNDATION_SEAMS);

/** Every seam registered so far (the coverage gate's vocabulary). */
export function knownSeams() { return [...known].sort(); }

/** Irreversibly seal the mutation registry in this process and clear active seams. */
export function sealSeams() {
  sealed = true;
  activeSet.clear();
}

/** Whether mutation seams have been sealed in this process. */
export function seamsSealed() {
  return sealed;
}

export function active(name) {
  if (!known.has(name)) throw new Error(`unknown mutation seam: ${name}`);
  return !sealed && activeSet.has(name);
}

export function enable(name) {
  if (!known.has(name)) throw new Error(`unknown mutation seam: ${name}`);
  if (sealed) throw new Error('mutation seams are sealed in this process');
  activeSet.add(name);
}

export function disable(name) { activeSet.delete(name); }
export function clearAll() { activeSet.clear(); }
export function activeSeams() { return [...activeSet]; }

/** Run `fn` with `name` enabled, restoring the previous state afterwards. */
export async function withMutation(name, fn) {
  const had = activeSet.has(name);
  enable(name);
  try { return await fn(); } finally { if (!had) disable(name); }
}
