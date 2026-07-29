// Shared helpers for WorkerAdapters (spec §4). Every adapter is a pure I/O shim:
// it spawns its harness in headless mode on the MODEL plane and maps the result
// to the scheduler's standard shape. The result mapping and the default exec are
// identical across harnesses, so they live here.

import { spawnAsync } from '../spawn-async.mjs';

/**
 * The registry sentinel meaning "let the harness resolve its own default"
 * (operating-stack §4b). It is the one `model` value that is NOT forced onto the
 * command line: passing the literal string `default` to a CLI would name a model
 * that does not exist.
 */
export const HARNESS_DEFAULT_ALIAS = 'default';

/**
 * Render the §4c FORCE half: the dispatcher's chosen model, explicitly, rather
 * than the harness's ambient default. Returns the flag pair or nothing.
 */
export function modelArgs(flag, model) {
  if (typeof model !== 'string' || model.length === 0) return [];
  if (model === HARNESS_DEFAULT_ALIAS) return [];
  return [flag, model];
}

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
