// Process-identity probes for the lock's PID-reuse-proof liveness check
// (spec §6.4; adversarial-review N5). Kept isolated so the lock logic stays pure
// and these host-specific reads are the only impure part.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

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
    // EPERM means it exists but we can't signal it → still alive.
    return e.code === 'EPERM';
  }
}

/**
 * A stable per-process start-time token, used to detect PID reuse. On Linux the
 * kernel's `starttime` (field 22 of /proc/<pid>/stat, in clock ticks since boot)
 * is monotonic and reused-pid-distinct; elsewhere fall back to `ps -o lstart`.
 * Returns null if it cannot be determined (the lock check then relies on pid
 * liveness alone — no worse than before N5).
 */
export function procStartTimeOf(pid) {
  if (typeof pid !== 'number') return null;
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22 is starttime; the process name in field 2 can contain spaces
      // and parens, so split on the LAST ')' first.
      const after = stat.slice(stat.lastIndexOf(')') + 2);
      const fields = after.split(' ');
      return fields[19] ?? null; // 0-based index 19 == field 22 overall
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** The current process's own identity, for stamping into the lock owner file. */
export function selfIdentity() {
  return {
    pid: process.pid,
    host: thisHost(),
    procStartTime: procStartTimeOf(process.pid),
  };
}

/** Probes object for lock.isLockLive / lock.acquireLock. */
export function lockProbes() {
  return { host: thisHost(), pidAlive, procStartTimeOf };
}
