// The shared spawn wrapper (spec §12.1, AC 49, AC 64, AC 102).
//
// EVERY child the autopilot starts goes through here: `shell:false` and an
// argv array (never a string), its own process group, a deadline (SIGTERM to
// the group, SIGKILL 15 s later), stdin CLOSED unless the caller passes
// `stdinBytes` (the enumerated stdin-bearing commands deliver their payload as
// bytes and end the stream — a prompt is never an argv element, which /proc
// exposes to every process, and never a file), and a stdout cap that KILLS the
// child on overflow and marks the capture `truncated`.
//
// The recorder seam is what the offline tests assert against: every spawn is
// recorded {argv, cwd, env, stdinBytes, label, deadlineMs} BEFORE it starts, so
// a test can classify the complete spawn list (read-only set, key-bearing set,
// host-bound gh set) rather than sampling.

import { spawn as cpSpawn } from 'node:child_process';
import { active } from './mutations.mjs';

export const KILL_GRACE_MS = 15_000;
export const DEFAULT_STDOUT_CAP = 4 * 1024 * 1024; // 4 MiB (§4.1, §6.6)

/** Deadlines per §12.1, in milliseconds. */
export const DEADLINES = Object.freeze({
  gitNetwork: 120_000,      // ls-remote, fetch <oid>, push
  git: 60_000,              // worktree add/remove, rebase, diff, rev-parse
  gh: 60_000,
  npmCi: 15 * 60_000,
  preflightScript: 30 * 60_000,
  fleetGraceMs: 5 * 60_000, // added to --wall-clock-minutes
  finalReview: 15 * 60_000,
  adlcRecorder: 60_000,
  quotaHttp: 10_000,
  usageFallback: 60_000,
  claude: 5 * 60_000,       // shaping, coldstart answer, token refresh
  ciPoll: 60_000,
});

/** Backoff schedule for the retried network commands (§12.1): 5 s, 15 s, 45 s. */
export const RETRY_BACKOFF_MS = Object.freeze([5_000, 15_000, 45_000]);

function signalGroup(pid, signal, kill) {
  try { kill(-pid, signal); } catch { /* already gone */ }
}

/**
 * Create a spawner bound to a recorder and injectable clocks.
 *
 * @param opts.recorder  optional array (or {push}) that receives every spawn record
 * @param opts.spawnImpl injectable child_process.spawn (tests substitute a fake)
 * @param opts.kill      injectable process.kill
 */
export function createSpawner({ recorder = null, spawnImpl = cpSpawn, kill = process.kill, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  /**
   * @param req.argv        [cmd, ...args] — cmd is the executable (absolute for pinned tools)
   * @param req.cwd
   * @param req.env         the COMPLETE environment of the child (nothing is inherited implicitly)
   * @param req.stdinBytes  string|Buffer written to stdin then ended; absent → stdin closed
   * @param req.deadlineMs  wall-clock budget; expiry → SIGTERM group, SIGKILL after KILL_GRACE_MS
   * @param req.stdoutCap   bytes; exceeding it kills the child and marks `truncated`
   * @param req.label       for the recorder / timeout reason (`timeout:<label>`)
   * @returns Promise<{ status, signal, stdout, stderr, timedOut, truncated, error, reason }>
   */
  return function spawn(req) {
    const { argv, cwd, env = {}, stdinBytes, deadlineMs, stdoutCap = DEFAULT_STDOUT_CAP, label } = req;
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      throw new TypeError('spawn: argv must be a non-empty array of strings');
    }
    if (env === null || typeof env !== 'object') throw new TypeError('spawn: env must be an object');
    const name = label ?? argv[0];
    // Mutation seams: `spawn.shellTrue` (argv safety) and `spawn.noDeadline` (§12.1).
    const shell = active('spawn.shellTrue');
    const armDeadline = deadlineMs != null && !active('spawn.noDeadline');
    const record = { argv: [...argv], cwd, env: { ...env }, stdinBytes: stdinBytes === undefined ? null : Buffer.from(stdinBytes), label: name, deadlineMs: armDeadline ? deadlineMs : null, shell };
    recorder?.push(record);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(argv[0], argv.slice(1), {
          cwd, env, shell, detached: true,
          stdio: [stdinBytes === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ error, status: null, signal: null, stdout: '', stderr: '', timedOut: false, truncated: false, reason: `spawn-failed:${name}` });
        return;
      }
      const out = []; let outBytes = 0;
      const err = []; let errBytes = 0;
      let timedOut = false; let truncated = false; let settled = false;
      let timer = null; let grace = null;
      const terminate = (why) => {
        if (why === 'timeout') timedOut = true; else truncated = true;
        if (child.pid) {
          signalGroup(child.pid, 'SIGTERM', kill);
          grace = setTimeoutFn(() => signalGroup(child.pid, 'SIGKILL', kill), KILL_GRACE_MS);
        }
      };
      if (armDeadline) timer = setTimeoutFn(() => terminate('timeout'), deadlineMs);
      child.stdout?.on('data', (d) => {
        if (truncated) return;
        outBytes += d.length;
        if (outBytes > stdoutCap) { terminate('overflow'); return; }
        out.push(d);
      });
      child.stderr?.on('data', (d) => { errBytes += d.length; if (errBytes <= stdoutCap) err.push(d); });
      if (stdinBytes !== undefined && child.stdin) {
        child.stdin.on('error', () => { /* child may exit early */ });
        child.stdin.end(stdinBytes);
      }
      const finish = (payload) => {
        if (settled) return; settled = true;
        if (timer) clearTimeoutFn(timer); if (grace) clearTimeoutFn(grace);
        record.result = { status: payload.status, signal: payload.signal, timedOut: payload.timedOut, truncated: payload.truncated };
        resolve(payload);
      };
      child.on('error', (error) => finish({ error, status: null, signal: null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, truncated, reason: `spawn-failed:${name}` }));
      child.on('close', (status, signal) => finish({
        status, signal,
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        timedOut, truncated, error: null,
        reason: timedOut ? `timeout:${name}` : truncated ? `stdout-cap:${name}` : null,
      }));
    });
  };
}

/**
 * Retry a network command per §12.1: up to 3 attempts with the fixed backoff,
 * only for the retryable outcomes the caller names (a lease failure on push is
 * NEVER retried — the caller passes `retryable: () => false` there).
 */
export async function withRetry(run, { retryable = (r) => r.status !== 0, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), backoff = RETRY_BACKOFF_MS } = {}) {
  let last;
  for (let i = 0; i <= backoff.length; i++) {
    last = await run(i + 1);
    if (last.status === 0 || !retryable(last)) return last;
    if (i < backoff.length) await sleep(backoff[i]);
  }
  return last;
}
