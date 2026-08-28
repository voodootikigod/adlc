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

/** Signal a process group (negative pid) without throwing on an already-gone group. */
function signalGroup(pid, signal, kill = process.kill) {
  try { kill(-pid, signal); } catch { /* already gone */ }
}

export function spawnAsync(cmd, args = [], opts = {}) {
  const {
    killGroup = false,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    kill = process.kill,
    ...spawnOpts
  } = opts;
  return new Promise((resolve) => {
    // Some harness workers take their prompt on STDIN (e.g. agy --print); pass it
    // via `opts.input`. Long prompts on stdin also avoid ARG_MAX limits.
    const stdin = spawnOpts.input !== undefined ? 'pipe' : 'ignore';
    let child;
    try {
      child = cpSpawn(cmd, args, { ...spawnOpts, detached: killGroup ? true : spawnOpts.detached, stdio: [stdin, 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error, status: null, stdout: '', stderr: '' });
      return;
    }
    if (spawnOpts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* child may exit before we finish writing */ });
      child.stdin.end(spawnOpts.input);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer;
    let graceTimer;
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { stdout += d; }); }
    if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { stderr += d; }); }
    const terminate = () => {
      timedOut = true;
      if (killGroup && child.pid) {
        signalGroup(child.pid, 'SIGTERM', kill);
        graceTimer = setTimeoutFn(() => signalGroup(child.pid, 'SIGKILL', kill), killGraceMs);
      } else {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
    };
    if (spawnOpts.timeout) timer = setTimeoutFn(terminate, spawnOpts.timeout);
    const clear = () => { if (timer) clearTimeoutFn(timer); if (graceTimer) clearTimeoutFn(graceTimer); };
    child.on('error', (error) => { clear(); resolve({ error, status: null, stdout, stderr, timedOut }); });
    child.on('close', (status, signal) => {
      clear();
      resolve({ status, signal, stdout, stderr, timedOut: timedOut || signal === 'SIGTERM' });
    });
  });
}
