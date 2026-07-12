// The deterministic pre-merge gates (spec §8.3) plus the flail check (§12).
//
// - Build/test gate commands run through the Sandbox on the repo-command plane
//   (§7.3) with the scrubbed repo-command env (§7.2) — this is the arbitrary-code
//   containment.
// - The scope check is a PURE function over the ticket-local changed paths
//   (`startSha..HEAD`, N3) and the ticket's scope globs — fleet's own code, not a
//   worker promise.
// - flail-detector is consulted between strikes and FAILS OPEN (§12): an
//   unverifiable signal must not cut a build's normal retry short.

import { execFileSync } from 'node:child_process';
import { inScope } from '@adlc/core';

/**
 * Run one gate command inside the sandbox. Returns { ok, output }. A non-zero
 * exit or a thrown sandbox error is a gate failure (ok:false), never a throw —
 * the scheduler decides what a failure means (a strike).
 */
export function runGateCommand(sandbox, command, env) {
  const argv = ['/bin/sh', '-c', command];
  try {
    const output = sandbox.run(argv, { env });
    return { ok: true, output: String(output ?? '') };
  } catch (e) {
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

/** Run the configured build + test gate commands in order; stop at first failure. */
export function runGates(sandbox, gate, env) {
  const results = [];
  for (const key of ['build', 'test']) {
    const cmd = gate?.[key];
    if (!cmd) continue;
    const r = runGateCommand(sandbox, cmd, env);
    results.push({ key, ...r });
    if (!r.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

/**
 * Paths in the ticket-local diff that fall OUTSIDE the ticket's declared scope
 * (§8.3c). Pure — the caller supplies `changedPaths` from
 * `git diff --name-only <startSha>..HEAD`.
 */
export function scopeViolations(changedPaths, ticket) {
  if (!ticket.scope || ticket.scope.length === 0) {
    // No scope declared → any change is out of scope (fail closed rather than
    // treating an unscoped ticket as "may touch anything").
    return [...changedPaths];
  }
  return changedPaths.filter((p) => !inScope(ticket, p));
}

/**
 * Consult flail-detector on the accumulated worker log between strikes.
 * Returns { flail:boolean, signals:[] }. FAILS OPEN: any error → not-flail, so
 * the two-strike cap remains the backstop (§12).
 *
 * @param exec  injectable runner: (bin, args) => stdout string
 */
export function checkFlail(logFile, scope, { adlcBin = 'adlc', exec = defaultExec } = {}) {
  try {
    const args = ['flail-detector', logFile, '--json'];
    for (const g of scope ?? []) args.push('--scope', g);
    const out = exec(adlcBin, args);
    const parsed = JSON.parse(out);
    return { flail: parsed.detected === true, signals: parsed.signals ?? [] };
  } catch {
    return { flail: false, signals: [], failedOpen: true };
  }
}

function defaultExec(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8' });
}
