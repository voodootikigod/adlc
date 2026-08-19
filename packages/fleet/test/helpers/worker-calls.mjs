// Test helper: recover the INNER command from a recorded worker spawn.
//
// Since #395 the model plane is wrapped like the repo-command plane, so what
// reaches `io.spawnWorker` is `bwrap … -- claude -p …` (or `sandbox-exec -p
// <profile> claude -p …`), not `claude -p …`. A test that asserts on the harness
// the fleet chose wants the inner argv; a test that asserts on containment wants
// the wrapper. This makes the first kind say so, instead of every such test
// growing its own slice arithmetic.

/**
 * Strip a sandbox wrapper from one recorded `{ cmd, args, … }` spawn.
 * A call that is not wrapped is returned unchanged, so a test can use this
 * uniformly across `sandbox` and `env-scrub-only` modes.
 */
export function unwrap(call) {
  if (!call) return call;
  const argv = [call.cmd, ...(call.args ?? [])];
  let inner = null;
  if (call.cmd === 'bwrap') {
    const sep = argv.indexOf('--');
    if (sep !== -1) inner = argv.slice(sep + 1);
  } else if (call.cmd === 'sandbox-exec') {
    // sandbox-exec -p <profile> <inner…>
    inner = argv.slice(3);
  }
  if (!inner || inner.length === 0) return call;
  return { ...call, wrapper: { cmd: call.cmd, args: call.args }, cmd: inner[0], args: inner.slice(1) };
}

/** Unwrap every recorded spawn. */
export const unwrapAll = (calls) => (calls ?? []).map(unwrap);

/** The first recorded spawn whose INNER command is `cmd`. */
export const findInner = (calls, cmd) => unwrapAll(calls).find((c) => c.cmd === cmd);
