// Non-blocking child-process execution (github #164). The live fleet MUST NOT
// use spawnSync on the per-ticket worker/gate/review hot path: a synchronous
// spawn blocks the Node event loop, serializing the concurrent scheduler. This
// promise-wrapped `spawn` yields the loop while a child runs, so independent
// tickets' workers/gates actually overlap.
//
// Returns the SAME shape the code expects from spawnSync:
//   { status, signal, stdout, stderr, error, timedOut }
// so it is a drop-in for the injected exec/spawn seams.

import { spawn as cpSpawn } from 'node:child_process';

export function spawnAsync(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    // Some harness workers take their prompt on STDIN (e.g. agy --print); pass it
    // via `opts.input`. Long prompts on stdin also avoid ARG_MAX limits.
    const stdin = opts.input !== undefined ? 'pipe' : 'ignore';
    let child;
    try {
      child = cpSpawn(cmd, args, { ...opts, stdio: [stdin, 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ error, status: null, stdout: '', stderr: '' });
      return;
    }
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* child may exit before we finish writing */ });
      child.stdin.end(opts.input);
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer;
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { stdout += d; }); }
    if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { stderr += d; }); }
    if (opts.timeout) {
      timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* already gone */ } }, opts.timeout);
    }
    child.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ error, status: null, stdout, stderr, timedOut }); });
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, timedOut: timedOut || signal === 'SIGTERM' });
    });
  });
}
