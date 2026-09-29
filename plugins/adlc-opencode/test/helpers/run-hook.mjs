// run-hook.mjs — the one place tests in this directory spawn a child Node
// process. Every spawn gets a SIGKILL deadline, and a killed run's output
// throws instead of reading as an empty result.

import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Wall-clock ceiling for one hook run. Deliberately generous: the value is the
 * existence of a bound, not its tightness. A wedged child overruns any
 * plausible budget by orders of magnitude (the trees found in the wild had been
 * running for days), while a slow CI runner legitimately needs room.
 */
export const HOOK_TIMEOUT_MS = 30_000;

/**
 * Resolve a caller's options into bounded ones.
 *
 * `timeout` and `killSignal` are written AFTER the caller's options on purpose.
 * They are the two properties that make the bound enforceable, so neither may
 * be unset or weakened by a call site: spreading the caller last would let
 * `{ timeout: undefined }` silently restore an unbounded spawn, and a
 * `killSignal: 'SIGTERM'` override would soften the reap. A caller may still
 * RAISE or LOWER the deadline by passing a finite positive number.
 *
 * `timeout: 0` is deliberately rejected: Node reads it as "no timeout", which
 * is the exact hole this helper exists to close.
 */
export function resolveSpawnOptions(opts = {}) {
  const override = opts.timeout;
  const timeout =
    typeof override === 'number' && Number.isFinite(override) && override > 0
      ? override
      : HOOK_TIMEOUT_MS;
  return { encoding: 'utf8', ...opts, timeout, killSignal: 'SIGKILL' };
}

/** Did this error/result come from the deadline rather than from the hook? */
function killedByDeadline(carrier) {
  return (
    carrier?.code === 'ETIMEDOUT' ||
    carrier?.error?.code === 'ETIMEDOUT' ||
    carrier?.signal === 'SIGKILL' ||
    carrier?.signal === 'SIGTERM'
  );
}

/**
 * Make a killed run unreadable as a result.
 *
 * Adding a deadline creates a failure mode that not having one did not have.
 * Call sites here overwhelmingly do `catch (e) { out = e.stdout ?? ''; }`, and
 * for an advisory hook "no output" is a PASS — so a timeout would quietly
 * satisfy a test asserting deliberate silence. Before the deadline existed the
 * same hang stalled the runner: ugly, but never green.
 *
 * Reading stdout/stderr/status off a killed run therefore throws rather than
 * yielding an empty string. Those catch blocks keep working for real nonzero
 * exits, which is what they are for, and fail loudly on a deadline, which they
 * must not absorb.
 */
function refuseKilledOutput(carrier, timeout) {
  if (!killedByDeadline(carrier)) return carrier;
  const message =
    `hook spawn exceeded its ${timeout}ms deadline and was killed — its output is not a result. ` +
    'Assert on the timeout rather than reading the empty output as the hook’s answer.';
  const refuse = () => {
    throw new Error(message);
  };
  for (const field of ['stdout', 'stderr', 'status', 'output']) {
    Object.defineProperty(carrier, field, { get: refuse, configurable: true });
  }
  carrier.timedOut = true;
  return carrier;
}

/** execFileSync a child Node process. Throws on nonzero exit, as execFileSync does. */
export function runHook(args, opts = {}) {
  const options = resolveSpawnOptions(opts);
  try {
    return execFileSync(process.execPath, args, options);
  } catch (err) {
    throw refuseKilledOutput(err, options.timeout);
  }
}

/** spawnSync a child Node process. Returns the result object; never throws on exit code. */
export function spawnHook(args, opts = {}) {
  const options = resolveSpawnOptions(opts);
  return refuseKilledOutput(spawnSync(process.execPath, args, options), options.timeout);
}

