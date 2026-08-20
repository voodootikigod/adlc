/**
 * Undo that cannot overwrite somebody else's work.
 *
 * A rollback restores a snapshot taken before the run started. That is correct
 * only while the artifact still holds what THIS run put there — and the failure
 * that triggers a rollback is often precisely a concurrent writer, so "restore
 * the snapshot" can mean "delete the record that just beat us". Every restore
 * here is therefore a compare-and-swap on the bytes: ours, or hands off.
 *
 * A skipped restore is reported, never swallowed. The operator needs to know
 * which artifacts are back and which now belong to someone else, because that
 * pair is the difference between "nothing happened" and "half of it stands".
 *
 * Scope of the guarantee: the compare and the mutation below are two syscalls,
 * not one atomic operation. Writers that follow the protocol are serialized by
 * the session locks, and `wroteBytes` is carried from each write call itself
 * (never sampled from disk afterwards), so within the protocol the guard is
 * exact. A writer that bypasses BOTH the locks and the hook protections can
 * still land between the compare and the mutation; POSIX offers no
 * conditional-unlink to close that, so the residual window is accepted and
 * kept as narrow as two adjacent syscalls.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Current bytes at `path`, or null when it does not exist / cannot be read. */
export function currentBytes(path, { fs = { existsSync, readFileSync } } = {}) {
  try {
    if (!fs.existsSync(path)) return null;
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Put `priorBytes` back at `path` only if it still holds `wroteBytes`.
 *
 * @param {object} opts
 * @param {string} opts.path
 * @param {string|null} opts.wroteBytes what this run left there (null = it
 *        created nothing, so anything present is somebody else's)
 * @param {string|null} opts.priorBytes what was there before (null = absent,
 *        so the restore is a delete)
 * @param {string} opts.label artifact name for the conflict report
 * @returns {{ restored: boolean, conflict: boolean, label: string }}
 */
export function restoreIfOurs({ path, wroteBytes, priorBytes, label }, io = {}) {
  const fs = {
    existsSync,
    readFileSync,
    writeFileSync,
    unlinkSync,
    mkdirSync,
    ...io.fs,
  };
  const now = currentBytes(path, { fs });
  if (now !== wroteBytes) {
    // Someone replaced (or removed) what we wrote. Their state is newer than
    // our snapshot by definition — restoring would be the overwrite this
    // guard exists to prevent.
    return { restored: false, conflict: true, label };
  }
  try {
    if (priorBytes === null) {
      if (now !== null) fs.unlinkSync(path);
    } else {
      fs.mkdirSync(dirname(path), { recursive: true });
      fs.writeFileSync(path, priorBytes, 'utf8');
    }
    return { restored: true, conflict: false, label };
  } catch {
    // Best-effort: the caller is already reporting a failure, and a restore
    // that cannot be performed is reported as a conflict rather than silence.
    return { restored: false, conflict: true, label };
  }
}

/**
 * Human-readable summary of what a rollback could not put back.
 * @param {{ restored: boolean, conflict: boolean, label: string }[]} results
 * @returns {string} empty when everything was restored
 */
export function conflictReport(results) {
  const conflicts = results.filter((r) => r?.conflict).map((r) => r.label);
  if (conflicts.length === 0) return '';
  return `rollback left ${conflicts.join(', ')} as found — changed by another writer since this run wrote them`;
}
