// Shared helpers for WorkerAdapters (spec §4). Every adapter is a pure I/O shim:
// it spawns its harness in headless mode on the MODEL plane and maps the result
// to the scheduler's standard shape. The result mapping and the default exec are
// identical across harnesses, so they live here.

import { spawnAsync } from '../spawn-async.mjs';

export function defaultExec(cmd, args, opts) {
  return spawnAsync(cmd, args, { ...opts, encoding: 'utf8' });
}

/** Map a spawn result to the adapter contract: { exitCode, output, timedOut }. */
export function mapResult(res) {
  const timedOut = res.signal === 'SIGTERM' || res.killed === true || res.timedOut === true;
  return {
    exitCode: typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1),
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`,
    timedOut,
  };
}
