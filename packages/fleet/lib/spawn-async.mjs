// Non-blocking child-process execution (github #164). The live fleet MUST NOT
// use spawnSync on the per-ticket worker/gate/review hot path: a synchronous
// spawn blocks the Node event loop, serializing the concurrent scheduler. This
// promise-wrapped `spawn` yields the loop while a child runs, so independent
// tickets' workers/gates actually overlap.
//
// Returns the SAME shape the code expects from spawnSync:
//   { status, signal, stdout, stderr, error, timedOut }
// so it is a drop-in for the injected exec/spawn seams.
//
// `killGroup` (fleet-ext item 5): the worker is a process TREE (a harness that
// forks tool subprocesses), and a SIGTERM to the leader alone leaves the rest
// running past the wall clock. With `killGroup` the child is started as the
// leader of its own process group and the timeout signals the whole group —
// SIGTERM first, SIGKILL after `killGraceMs` if it is still alive.

import { spawn as cpSpawn } from 'node:child_process';

export const DEFAULT_KILL_GRACE_MS = 15_000;
/** Output accumulated per stream before the rest is DROPPED (codex r13 #3): a chatty child
 * cannot exhaust the orchestrator. Callers with a smaller budget pass `maxOutputBytes`. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Signal a process group (negative pid) without throwing on an already-gone group. */
function signalGroup(pid, signal, kill = process.kill) {
  try { kill(-pid, signal); } catch { /* already gone */ }
}

export function spawnAsync(cmd, args = [], opts = {}) {
  const {
    killGroup = false,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    kill = process.kill,
    spawnImpl = cpSpawn, // injectable for tests that drive a fake leader
    ...spawnOpts
  } = opts;
  return new Promise((resolve) => {
    // Some harness workers take their prompt on STDIN (e.g. agy --print); pass it
    // via `opts.input`. Long prompts on stdin also avoid ARG_MAX limits.
    const stdin = spawnOpts.input !== undefined ? 'pipe' : 'ignore';
    let child;
    // `timeout` is OURS: node's own spawn timeout would SIGTERM the leader alone and race
    // the group termination below (agy r2 c4). It never reaches the underlying spawn.
    const { timeout: _ownTimeout, ...forSpawn } = spawnOpts;
    try {
      child = spawnImpl(cmd, args, { ...forSpawn, detached: killGroup ? true : spawnOpts.detached, stdio: [stdin, 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error, status: null, stdout: '', stderr: '' });
      return;
    }
    if (spawnOpts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* child may exit before we finish writing */ });
      child.stdin.end(spawnOpts.input);
    }
    const out = { chunks: [], bytes: 0 };
    const err = { chunks: [], bytes: 0 };
    let truncated = false;
    const cap = Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 ? maxOutputBytes : null;
    // Keep reading (the child is never blocked on a full pipe); drop what exceeds the cap. The cap
    // is in BYTES of raw output (codex r17 #2): chunks stay Buffers and are decoded once at the end.
    const take = (acc, d) => {
      if (cap == null) { acc.chunks.push(d); acc.bytes += d.length; return; }
      if (acc.bytes >= cap) { truncated = true; return; }
      const room = cap - acc.bytes;
      if (d.length > room) { truncated = true; acc.chunks.push(d.subarray(0, room)); acc.bytes += room; return; }
      acc.chunks.push(d); acc.bytes += d.length;
    };
    const text = (acc) => Buffer.concat(acc.chunks, acc.bytes).toString('utf8');
    let timedOut = false;
    let timer;
    let graceTimer;
    if (child.stdout) child.stdout.on('data', (d) => take(out, d));
    if (child.stderr) child.stderr.on('data', (d) => take(err, d));
    let groupKilled = false;
    const killTheGroup = () => { if (groupKilled) return; groupKilled = true; signalGroup(child.pid, 'SIGKILL', kill); };
    const terminate = () => {
      timedOut = true;
      if (killGroup && child.pid) {
        signalGroup(child.pid, 'SIGTERM', kill);
        graceTimer = setTimeoutFn(killTheGroup, killGraceMs);
      } else {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    };
    if (spawnOpts.timeout) timer = setTimeoutFn(terminate, spawnOpts.timeout);
    const clear = () => { if (timer) clearTimeoutFn(timer); if (graceTimer) clearTimeoutFn(graceTimer); };
    child.on('error', (error) => { clear(); resolve({ error, status: null, stdout: text(out), stderr: text(err), timedOut, truncated }); });
    child.on('close', (status, signal) => {
      clear();
      // The leader may exit on SIGTERM while a descendant lives on: after a timeout
      // the whole GROUP gets the SIGKILL now, not a grace timer the close just
      // cancelled (codex r7). And a leader that exits NORMALLY after forking a
      // background helper must not leave it running while the scheduler goes on to
      // commit, gate, prosecute and merge the worktree (codex r23 #1): with
      // `killGroup` the group dies with its leader on every exit, not only a timeout.
      if (killGroup && child.pid) killTheGroup();
      resolve({ status, signal, stdout: text(out), stderr: text(err), timedOut: timedOut || signal === 'SIGTERM', truncated });
    });
  });
}
