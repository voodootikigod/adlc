// packages/core/lib/proc.mjs
// Process-identity probes for PID-reuse-proof lock liveness checks.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

/** Returns the current machine's hostname. */
export function thisHost() {
  return hostname();
}

/** True if a process with `pid` currently exists (signal 0 probe). */
export function pidAlive(pid) {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * A stable per-process start-time token, used to detect PID reuse. On Linux the
 * kernel's `starttime` (field 22 of /proc/<pid>/stat, in clock ticks since boot)
 * is monotonic and reused-pid-distinct; elsewhere fall back to `ps -o lstart=`.
 * Returns null if it cannot be determined.
 */
export function procStartTimeOf(
  pid,
  { platform = process.platform, readFile = readFileSync, execFile = execFileSync } = {}
) {
  if (typeof pid !== 'number') return null;
  try {
    if (platform === 'linux') {
      const stat = readFile('/proc/' + pid + '/stat', 'utf8');
      const after = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = after.split(' ');
      return fields[19] || null;
    }
    const out = execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** The current process's own identity, for stamping into lock owner files. */
export function selfProcessIdentity() {
  const start = procStartTimeOf(process.pid);
  return { pid: process.pid, host: thisHost(), procStartTime: start, pidStartTime: start };
}

/** Default probes object for lock liveness and staleness checks. */
export function defaultLockProbes() {
  return { host: thisHost(), pidAlive, procStartTimeOf, pidStartTimeOf: procStartTimeOf };
}
