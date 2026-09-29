/**
 * Bounded, read-only git calls for the read path.
 *
 * Every read in a sweep is a synchronous child process, and a git that stalls
 * (a lock held by another process, a hung filesystem, a credential prompt behind
 * a lazy-fetch remote) would block the sweep forever with no operational error.
 * Each call gets a finite timeout and SIGKILL, so a stall becomes an ordinary
 * failure the caller already handles.
 */

import { execFileSync } from 'node:child_process';

/** How long one git read may take. */
export const GIT_READ_TIMEOUT_MS = 30_000;

/** Output ceiling for one read — a cited file is read whole. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** The spawn options every read gets. stderr is discarded: a miss is an answer, not a fault. */
export function gitReadOpts() {
  return {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_READ_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  };
}

/** Run `git <args>` and return stdout as a string; throws on any failure. */
export function gitRead(args, run = execFileSync) {
  return String(run('git', args, gitReadOpts()));
}

/** `path`'s bytes at `rev`; throws when it is absent there. */
export function readFileAtRevision(path, rev = 'HEAD', run = execFileSync) {
  return gitRead(['show', `${rev}:${path}`], run);
}
