// packages/core/lib/inflight.mjs
// Crash-recovery and atomic in-flight helpers for mutations and file operations.

import {
  openSync,
  closeSync,
  writeFileSync,
  fchmodSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  readdirSync,
  lstatSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, resolve, relative, isAbsolute, sep, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * An unpredictable temp path next to `targetPath`.
 *
 * @param {string} targetPath
 * @param {number} [pid=process.pid]
 * @returns {string}
 */
export function makeTempPath(targetPath, pid = process.pid) {
  return `${targetPath}.tmp-${pid}-${randomBytes(8).toString('hex')}`;
}

/**
 * Replace a file's contents atomically with crash-safety and mode preservation.
 * Follows symlinks so that mutating a symlinked file writes through the link and
 * preserves the symlink itself.
 *
 * @param {string} targetPath
 * @param {string | NodeJS.ArrayBufferView} content
 * @param {{ tempPath?: string }} [options]
 */
export function writeInflightAtomic(targetPath, content, { tempPath } = {}) {
  let realTarget = targetPath;
  try {
    if (lstatSync(targetPath).isSymbolicLink()) {
      realTarget = realpathSync(targetPath);
    }
  } catch {
    // targetPath may not exist yet
  }

  let priorMode = null;
  try {
    priorMode = statSync(realTarget).mode & 0o777;
  } catch {
    // realTarget does not exist yet
  }

  const tmp = tempPath ?? makeTempPath(realTarget);
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', priorMode ?? 0o666);
    writeFileSync(fd, content, 'utf8');
    if (priorMode !== null) {
      fchmodSync(fd, priorMode);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, realTarget);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // ignore unlink error
    }
    throw err;
  }
}

/**
 * Probe whether a process owning an in-flight record is still running.
 * Tri-state: 'alive' | 'dead' | 'unknown'.
 *
 * @param {unknown} pid
 * @param {(pid: number, signal: number) => void} [killFn=process.kill]
 * @returns {'alive' | 'dead' | 'unknown'}
 */
export function probeOwner(pid, killFn = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    killFn(pid, 0);
    return 'alive';
  } catch (err) {
    if (err && err.code === 'ESRCH') return 'dead';
    if (err && err.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Ownership state for an in-flight record, treating PID reuse by ourselves as dead.
 *
 * @param {unknown} recordPid
 * @param {number} [selfPid=process.pid]
 * @param {(pid: unknown) => 'alive' | 'dead' | 'unknown'} [probe=probeOwner]
 * @returns {'alive' | 'dead' | 'unknown'}
 */
export function ownerStateFor(recordPid, selfPid = process.pid, probe = probeOwner) {
  if (recordPid === selfPid) return 'dead';
  return probe(recordPid);
}

/**
 * Checks whether relPath is a non-empty relative path that stays inside '.'.
 *
 * @param {unknown} relPath
 * @returns {boolean}
 */
export function isContainedRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (isAbsolute(relPath)) return false;
  const rel = relative('.', resolve('.', relPath));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves a repo-relative path to its real absolute path, ensuring it stays
 * strictly inside repoRoot even across symlinks.
 *
 * @param {string} repoRoot
 * @param {unknown} relFile
 * @returns {string | null}
 */
export function resolveTarget(repoRoot, relFile) {
  if (!isContainedRelPath(relFile)) return null;
  let realRoot;
  let realTarget;
  try {
    realRoot = realpathSync(repoRoot);
    realTarget = realpathSync(resolve(repoRoot, relFile));
  } catch {
    return null;
  }
  const rel = relative(realRoot, realTarget);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return realTarget;
}

/**
 * Sweep stale temp files next to targetPath left by crashed processes.
 *
 * @param {string} targetPath
 * @param {{ probe?: (pid: unknown) => 'alive' | 'dead' | 'unknown', selfPid?: number }} [options]
 * @returns {number} count of swept files
 */
export function sweepStaleTemps(targetPath, { probe = probeOwner, selfPid = process.pid } = {}) {
  let realTarget = targetPath;
  try {
    if (lstatSync(targetPath).isSymbolicLink()) {
      realTarget = realpathSync(targetPath);
    }
  } catch {
    // targetPath may not exist yet
  }
  const dir = dirname(realTarget);
  const base = basename(realTarget);
  const prefix = `${base}.tmp-`;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let swept = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const rest = entry.slice(prefix.length);
    const m = rest.match(/^(\d+)-[0-9a-f]+$/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (ownerStateFor(pid, selfPid, probe) === 'dead') {
      try {
        unlinkSync(join(dir, entry));
        swept += 1;
      } catch {
        // ignore removal error
      }
    }
  }
  return swept;
}

/**
 * Unlink a record path, ignoring ENOENT and rethrowing any other error.
 *
 * @param {string} recordPath
 */
export function clearRecord(recordPath) {
  try {
    unlinkSync(recordPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return;
    }
    throw err;
  }
}
