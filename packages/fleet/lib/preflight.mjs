// Preflight (spec §8.0) — everything that must hold BEFORE the first real
// dispatch, so the run fails fast and cheap instead of burning strikes. Ordered:
// resolve+require the sandbox → acquire the repo lock (stale recovery) → refuse
// on a dirty tree → probe the rail hook (loud warn, never silent) → canary
// dispatch (prove the permission plumbing) → record merge-forecast.
//
// Each check is a small, injectable function; runPreflight composes them.

import { detectBackend, resolveSandboxMode } from './sandbox.mjs';
import { acquireLock, releaseLock } from './lock.mjs';

/** Resolve the sandbox and require it (fail closed) per §7.3. */
export function resolveSandboxForRun(config, { platform, hasCmd } = {}) {
  const backend = detectBackend(platform, hasCmd);
  return resolveSandboxMode({
    backend,
    operatorOverride: config.operatorOverride === true,
    repoConfigOverride: config.repoConfigOverride === true,
  });
}

/** Refuse to run against a dirty main checkout. */
export function checkCleanTree(repoGit) {
  const dirty = repoGit('status', '--porcelain').trim().length > 0;
  return { ok: !dirty, reason: dirty ? 'main checkout has uncommitted changes; commit or stash before a fleet run' : null };
}

/**
 * Probe whether the ADLC plugin's PreToolUse rail hook is installed for the
 * worker. Best-effort and injectable; an ABSENT hook is a loud warning (in-session
 * enforcement is missing), never a silent proceed (spec §8.0(c)).
 */
export function railHookProbe(railHookInstalled) {
  let present;
  try { present = railHookInstalled() === true; } catch { present = false; }
  return {
    present,
    warning: present ? null :
      'WARNING: the ADLC Claude Code rail hook could not be confirmed installed for workers. ' +
      'In-session rail enforcement (§8.2) may be absent; only the deterministic pre-merge gates (§8.3) ' +
      'will protect rails. Proceeding, but this is not silent by design.',
  };
}

/**
 * Full preflight. Returns { ok, exitCode, sandboxSpec?, forecast?, warnings, reason?, lockHeld }.
 * On any refusal the lock (if taken) is released so the run leaves no stale lock.
 *
 * @param dispatchCanary  optional ({sandboxSpec}) => { ok, output } — runs one
 *                        allowlisted command in a throwaway worktree.
 * @param railHookInstalled () => boolean
 * @param self / probes   lock identity + liveness probes (lib/proc.mjs)
 */
export async function runPreflight({
  repo, config, statusDir, io, self, probes,
  dispatchCanary, railHookInstalled = () => false,
  platform, hasCmd, remainingMs = null,
}) {
  const warnings = [];

  // 0. Gate required (spec §7.1; adversarial-review M1). An ungated fleet would
  // merge scope-compliant but UNBUILT/UNTESTED code — fail closed before dispatch.
  if (!config.gate || (!config.gate.build && !config.gate.test)) {
    return { ok: false, exitCode: 1, reason: 'fleet.gate must define a build and/or test command in .adlc/config.json; an ungated fleet must not run', warnings, lockHeld: false };
  }

  // 1. Sandbox — resolve and require it (fail closed).
  const sb = resolveSandboxForRun(config, { platform, hasCmd });
  warnings.push(...(sb.warnings ?? []));
  if (sb.refused) return { ok: false, exitCode: 1, reason: sb.reason, warnings, lockHeld: false };

  // 2. Repo lock — single instance, stale recovery.
  const lock = acquireLock(statusDir, self, probes);
  if (lock.refused) {
    // `reasonCode` is the machine-readable twin of `reason` (fleet-ext item 9):
    // a held lock is a SKIP a caller retries later, never a failure to escalate.
    return { ok: false, exitCode: 1, reason: `another fleet run holds the lock (pid ${lock.owner?.pid} on ${lock.owner?.host})`, reasonCode: 'lock-held', warnings, lockHeld: false };
  }

  // 3. Clean tree.
  const tree = checkCleanTree(io.git(repo));
  if (!tree.ok) { releaseLock(statusDir); return { ok: false, exitCode: 1, reason: tree.reason, warnings, lockHeld: false }; }

  // 4. Rail-hook probe (loud warn, never silent).
  const rh = railHookProbe(railHookInstalled);
  if (!rh.present) warnings.push(rh.warning);

  // 5. Canary — prove the permission plumbing before real tickets.
  if (dispatchCanary) {
    const canary = await dispatchCanary({ sandboxSpec: sb });
    if (!canary.ok) {
      releaseLock(statusDir);
      return { ok: false, exitCode: 1, reason: `preflight canary failed (permission plumbing not working): ${canary.output ?? ''}`, warnings, lockHeld: false };
    }
  }

  // 6. Merge-forecast pre-run — evidence, recorded into the caller's status.
  let forecast = null;
  try {
    // Evidence only, but bounded: a hung forecast must not outlive the run's deadline (codex r10).
    const r = io.adlc(['merge-forecast', '--json'], typeof remainingMs === 'function' ? { timeout: remainingMs() } : {});
    if (r.stdout) forecast = JSON.parse(r.stdout);
  } catch { /* forecast is evidence, not a gate */ }

  return { ok: true, exitCode: 0, sandboxSpec: sb, forecast, warnings, lockHeld: true };
}
