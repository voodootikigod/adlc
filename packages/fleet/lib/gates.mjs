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
export async function runGateCommand(sandbox, command, env) {
  const argv = ['/bin/sh', '-c', command];
  try {
    const output = await sandbox.run(argv, { env });
    return { ok: true, output: String(output ?? '') };
  } catch (e) {
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` };
  }
}

/** Run the configured build + test gate commands in order; stop at first failure. */
export async function runGates(sandbox, gate, env) {
  const results = [];
  for (const key of ['build', 'test']) {
    const cmd = gate?.[key];
    if (!cmd) continue;
    const r = await runGateCommand(sandbox, cmd, env);
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

/** flail-detector's gate exit code for "I ran fine and the verdict is flail". */
const EXIT_FLAIL = 2;

/** The §12 backstop: an unverifiable signal must not cut a build's retry short. */
const failOpen = () => ({ flail: false, signals: [], failedOpen: true });

/**
 * Consult flail-detector on the accumulated worker log between strikes.
 * Returns { flail:boolean, signals:[] }, or the fail-open shape.
 *
 * Two things about the detector's real contract are easy to get wrong, and
 * getting either one wrong makes this consultation a silent no-op (#284):
 *
 *  - Its JSON document is `{ verdict: 'flail'|'clean', signals, bytes, ... }`.
 *    There is no `detected` field and never has been.
 *  - It is an ADLC gate, so it signals its verdict through the EXIT CODE too:
 *    0 = clean, 1 = operational error, 2 = flail. Exit 2 is a successful run
 *    reporting a positive finding — not a failure — but execFileSync throws on
 *    any non-zero exit, so that document arrives on the thrown error.
 *
 * Only genuinely unverifiable outcomes fail open (§12): a spawn failure, an
 * operational error (exit 1), or a document whose verdict we do not recognize.
 * That last case is deliberate — if the detector's schema drifts again, this
 * fails open loudly rather than silently reporting every session as clean.
 *
 * @param exec  injectable runner: (bin, args) => stdout string. Mirrors
 *              execFileSync: a non-zero exit THROWS, and the thrown error
 *              carries `status` (the exit code) and `stdout` (the document).
 *              A mock that cannot represent that cannot represent a flail.
 */
export function checkFlail(logFile, scope, { adlcBin = 'adlc', exec = defaultExec } = {}) {
  const args = ['flail-detector', logFile, '--json'];
  for (const g of scope ?? []) args.push('--scope', g);

  let out;
  try {
    out = exec(adlcBin, args);
  } catch (e) {
    // Exit 2 is a verdict, not an error — recover the document it printed.
    if (e?.status !== EXIT_FLAIL || typeof e.stdout !== 'string') return failOpen();
    out = e.stdout;
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return failOpen();
  }

  if (parsed?.verdict !== 'flail' && parsed?.verdict !== 'clean') return failOpen();
  return { flail: parsed.verdict === 'flail', signals: parsed.signals ?? [] };
}

function defaultExec(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8' });
}
