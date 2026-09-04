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
// same process), so they live on globalThis under one namespaced key. Every
// module REGISTERS the seams it consults at import time (`registerSeams`), so a
// typo in a seam name is a hard error at the first `active()` call and the
// coverage gate can list the complete seam vocabulary from the registry.

const KEY = '__adlcAutopilotMutations';

function state() {
  if (!globalThis[KEY]) globalThis[KEY] = { active: new Set(), known: new Set() };
  return globalThis[KEY];
}

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
  'records.skipRedaction',       // run records are written without structured redaction
  'paths.allowLinkedWorktree',   // a linked worktree is accepted as REPO_ROOT
]);

/** Register seam names a module consults. Idempotent; returns the names. */
export function registerSeams(names) {
  const s = state();
  for (const n of names) {
    if (typeof n !== 'string' || !/^[a-z][a-zA-Z0-9-]*\.[a-zA-Z][a-zA-Z0-9-]*$/.test(n)) throw new Error(`invalid seam name: ${n}`);
    s.known.add(n);
  }
  return names;
}
registerSeams(FOUNDATION_SEAMS);

/** Every seam registered so far (the coverage gate's vocabulary). */
export function knownSeams() { return [...state().known].sort(); }

export function active(name) {
  const s = state();
  if (!s.known.has(name)) throw new Error(`unknown mutation seam: ${name}`);
  return s.active.has(name);
}

export function enable(name) { const s = state(); if (!s.known.has(name)) throw new Error(`unknown mutation seam: ${name}`); s.active.add(name); }
export function disable(name) { state().active.delete(name); }
export function clearAll() { state().active.clear(); }
export function activeSeams() { return [...state().active]; }

/** Run `fn` with `name` enabled, restoring the previous state afterwards. */
export async function withMutation(name, fn) {
  const had = state().active.has(name);
  enable(name);
  try { return await fn(); } finally { if (!had) disable(name); }
}
