// Mutation seams (spec AC 1, AC 114, AC 121).
//
// The spec-coverage gate proves every registered test is load-bearing by
// injecting a DETERMINISTIC defect through a documented seam and asserting the
// test then FAILS. A seam is a named check a production module consults at the
// point where the defect would live; in production no seam is ever active
// (the registry is empty and `active()` is false), so the cost is one Set
// lookup on a cold path.
//
// Seams are process-wide (the gate runs the registered test functions in the
// same process), so they live on globalThis under one namespaced key.

const KEY = '__adlcAutopilotMutations';

function set() {
  if (!globalThis[KEY]) globalThis[KEY] = new Set();
  return globalThis[KEY];
}

/** The documented seam names. Adding a seam = adding a line here AND a check in lib/. */
export const SEAMS = Object.freeze([
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
  'records.skipRedaction',       // run records are written without structured redaction
  'paths.allowLinkedWorktree',   // a linked worktree is accepted as REPO_ROOT
]);

export function active(name) {
  if (!SEAMS.includes(name)) throw new Error(`unknown mutation seam: ${name}`);
  return set().has(name);
}

export function enable(name) { if (!SEAMS.includes(name)) throw new Error(`unknown mutation seam: ${name}`); set().add(name); }
export function disable(name) { set().delete(name); }
export function clearAll() { set().clear(); }

/** Run `fn` with `name` enabled, restoring the previous state afterwards. */
export async function withMutation(name, fn) {
  const had = set().has(name);
  enable(name);
  try { return await fn(); } finally { if (!had) disable(name); }
}
