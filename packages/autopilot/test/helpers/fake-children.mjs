// In-process fake children for the spawn wrapper (spec AC 1: "no subprocess
// outside the fakes"). A handler table keyed by executable path decides what a
// child prints and how it exits; a handler may declare that it ignores SIGTERM
// so the deadline path (SIGTERM → SIGKILL) is exercised deterministically.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

let nextPid = 40_000;

/**
 * @param handlers  { [exe]: (args, { cwd, env, stdin }) => { stdout?, stderr?, status?, signal?, ignoreSigterm?, hang?, delayMs? } | Promise }
 * @param kills     array receiving { pid, signal } for every kill() the wrapper issues
 */
export function fakeSpawnImpl(handlers, { kills = [] } = {}) {
  const children = new Map();
  const kill = (pid, signal) => {
    kills.push({ pid, signal });
    const child = children.get(Math.abs(pid));
    if (!child) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
    child._signal(signal);
  };
  function spawnImpl(exe, args, opts) {
    const handler = handlers[exe] ?? handlers['*'];
    if (!handler) { const e = new Error(`spawn ${exe} ENOENT`); e.code = 'ENOENT'; throw e; }
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const stdinChunks = [];
    child.stdin = new PassThrough();
    child.stdin.on('data', (d) => stdinChunks.push(Buffer.from(d)));
    let closed = false; let ignoreSigterm = false; let hang = false;
    const close = (status, signal = null) => {
      if (closed) return; closed = true;
      children.delete(child.pid);
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', status, signal));
    };
    child._signal = (signal) => {
      if (closed) return;
      if (signal === 'SIGTERM' && ignoreSigterm) return;
      close(null, signal);
    };
    children.set(child.pid, child);
    // Run the handler on the next tick so the wrapper has attached its listeners.
    setImmediate(async () => {
      let stdin = '';
      // Give a stdin writer one tick to finish.
      await new Promise((r) => setImmediate(r));
      stdin = Buffer.concat(stdinChunks).toString('utf8');
      let out;
      try { out = await handler(args, { cwd: opts?.cwd, env: opts?.env, stdin, exe }); }
      catch (e) { child.stderr.write(String(e.message)); close(1); return; }
      out = out ?? {};
      ignoreSigterm = out.ignoreSigterm === true;
      hang = out.hang === true;
      if (out.stdout) child.stdout.write(out.stdout);
      if (out.stderr) child.stderr.write(out.stderr);
      if (hang) return; // exits only when signalled
      if (out.delayMs) await new Promise((r) => setTimeout(r, out.delayMs));
      close(out.status ?? 0, out.signal ?? null);
    });
    return child;
  }
  return { spawnImpl, kill, children };
}

/** A handler that prints JSON and exits 0. */
export const json = (obj, status = 0) => () => ({ stdout: JSON.stringify(obj), status });
