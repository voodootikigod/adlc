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
export async function runGateCommand(sandbox, command, env, { timeoutMs = null } = {}) {
  const argv = ['/bin/sh', '-c', command];
  try {
    // fleet-ext item 5: an optional bound (the run's remaining wall clock) reaches
    // the sandbox as `timeout`, which the exec layer enforces on the child.
    // A budget of 0 is an EXPIRED budget, never "no timeout" (spawnAsync reads 0 as unbounded; agy fleet r9 c2).
    const output = await sandbox.run(argv, timeoutMs != null ? { env, timeout: Math.max(1, timeoutMs) } : { env });
    return { ok: true, output: String(output ?? '') };
  } catch (e) {
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`, timedOut: e?.timedOut === true };
  }
}

/** Run the configured build + test gate commands in order; stop at first failure. */
export async function runGates(sandbox, gate, env, opts = {}) {
  const results = [];
  for (const key of ['build', 'test']) {
    const cmd = gate?.[key];
    if (!cmd) continue;
    // `remaining()` is re-read before EVERY command: a build that ate most of the
    // budget leaves the test only what is left, never the stale figure (codex r10).
    const timeoutMs = typeof opts.remaining === 'function' ? opts.remaining() : opts.timeoutMs;
    const r = await runGateCommand(sandbox, cmd, env, { timeoutMs });
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

/**
 * The §12 backstop: an unverifiable signal must not cut a build's retry short.
 *
 * `reason` names WHY the verdict was unusable so the caller can surface it.
 * Without it every fail-open — missing detector, unwritable log, schema drift —
 * flattens into something indistinguishable from "this session is clean", which
 * is how a supervision control goes blind without anyone noticing (#309).
 */
const failOpen = (reason) => ({ flail: false, signals: [], failedOpen: true, reason });

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
 * operational error (exit 1), a document that will not parse, or a document
 * whose verdict we do not recognize. That last case is deliberate — if the
 * detector's schema drifts again, we would rather lose the signal than report
 * every session clean on a document we no longer understand.
 *
 * NOTE: `failedOpen` is currently advisory — no caller reads it (scheduler.mjs
 * consults `.flail` alone), so a fail-open is indistinguishable at runtime from
 * a genuine clean verdict. Surfacing it is tracked separately; do not read the
 * flag's presence here as "the operator will be told".
 *
 * @param exec  injectable runner: (bin, args) => stdout. Two shapes are
 *              accepted, because the two real implementations differ:
 *              - RETURN the detector's stdout for any exit code. This is what
 *                the production adapter does (live-deps.mjs, over spawnSync,
 *                which does not throw).
 *              - THROW an execFileSync-shaped error whose `status` is the exit
 *                code and `stdout` is the document. This is what `defaultExec`
 *                does, since execFileSync throws on any non-zero exit.
 *              Either way the EXIT CODE is the detector's own signal: 0 clean,
 *              1 operational error, 2 flail. A runner that discards the status
 *              and returns stdout regardless cannot distinguish 1 from 2, so
 *              it degrades to trusting the document alone.
 */
export function checkFlail(logFile, scope, { adlcBin = 'adlc', exec = defaultExec } = {}) {
  // `--opt=value` and the `--` terminator keep a glob or path that begins with
  // "-" from being parsed as a flag. The detector uses node:util.parseArgs in
  // strict mode, where a bare `--scope -weird/**` is a hard parse error (exit
  // 1) — which this function would then fail open on. A ticket's own scope
  // globs must never be able to switch its supervision off.
  const args = ['flail-detector', '--json'];
  for (const g of scope ?? []) args.push(`--scope=${g}`);
  args.push('--', logFile);

  let out;
  try {
    out = exec(adlcBin, args);
  } catch (e) {
    // Exit 2 is a verdict, not an error — recover the document it printed.
    if (e?.status !== EXIT_FLAIL || typeof e.stdout !== 'string') {
      // A numeric exit code means the detector RAN and reported an operational
      // failure; anything else means we never got a usable process at all.
      return failOpen(typeof e?.status === 'number' ? 'operational-error' : 'spawn-error');
    }
    out = e.stdout;
  }

  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return failOpen('unparseable');
  }

  if (parsed?.verdict !== 'flail' && parsed?.verdict !== 'clean') return failOpen('unrecognized-verdict');
  // `signals` gets the same strictness as `verdict`: the return shape is
  // documented as an array, so a drifted non-array is drift, not a value.
  if (parsed.signals !== undefined && !Array.isArray(parsed.signals)) return failOpen('unrecognized-verdict');
  return { flail: parsed.verdict === 'flail', signals: parsed.signals ?? [] };
}

// The detector's document embeds per-signal detail drawn from the session log,
// and the session log is written by the very agent this gate supervises. On
// Node's default 1 MiB maxBuffer, the noisiest sessions — exactly the ones the
// size and edit-churn signals exist to catch — would overflow and fail open.
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

function defaultExec(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
}
