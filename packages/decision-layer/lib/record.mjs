// The run record: one JSON line per completed run, appended to
// .adlc/decisions/runs.jsonl in the main checkout. `.adlc/*` is already ignored,
// so records are local telemetry, never committed evidence. A record holds the
// hash of the sanitized input, never the input itself.
//
// The log is the only file a run writes, so the write never follows a symbolic
// link: a repository that commits .adlc, .adlc/decisions or runs.jsonl as a link
// cannot redirect the append outside itself.
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { RecordError } from './errors.mjs';

export const RECORD_SCHEMA_VERSION = 1;
const LOG_DIRECTORIES = ['.adlc', 'decisions'];
const LOG_FILE = 'runs.jsonl';
const LOG_LOCK = 'runs.jsonl.lock';
const RELATIVE_LOG_PATH = `${LOG_DIRECTORIES.join('/')}/${LOG_FILE}`;
const APPEND_FLAGS = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
const LOCK_ATTEMPTS = 50;
const LOCK_SPIN_MS = 10;
const STALE_LOCK_MS = 30_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function tryReclaimStaleLock(lockDir) {
  try {
    const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
    if (owner?.hostname === hostname()) {
      if (isPidAlive(owner.pid)) return false;
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    if (typeof owner?.createdAt === 'number' && Date.now() - owner.createdAt > STALE_LOCK_MS) {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch {
    const st = lstatOrNull(lockDir);
    if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }
}

function withRecordLock(lockDir, fn) {
  const staging = `${lockDir}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  mkdirSync(staging, { mode: 0o700 });
  writeFileSync(join(staging, 'owner.json'), JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  }));
  let acquired = false;
  try {
    for (let i = 0; i < LOCK_ATTEMPTS; i += 1) {
      try {
        renameSync(staging, lockDir);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY' && error.code !== 'EPERM') throw error;
        if (tryReclaimStaleLock(lockDir)) continue;
        sleepSync(LOCK_SPIN_MS);
      }
    }
  } finally {
    if (!acquired) {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  if (!acquired) throw new Error(`timed out waiting for ${RELATIVE_LOG_PATH} lock`);
  try {
    return fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch { /* best-effort lock cleanup */ }
  }
}

/** Where runs from any worktree of the repository at `mainRoot` are recorded. */
export function recordPath(mainRoot) {
  return join(mainRoot, ...LOG_DIRECTORIES, LOG_FILE);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function refuseLink(path, stats) {
  if (stats?.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
}

/**
 * Make sure `dir` is a real directory, creating it if needed. Another run may
 * create it between the check and the mkdir: that EEXIST is not a failure, and
 * whatever now stands there is checked like anything found in the first place.
 */
function ensureDirectory(dir) {
  if (!lstatOrNull(dir)) {
    try {
      mkdirSync(dir);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const stats = lstatSync(dir);
  refuseLink(dir, stats);
  if (!stats.isDirectory()) throw new Error(`${dir} is not a directory`);
}

/** Append `record` as one line to the main checkout's log; any failure is a RecordError (the run was not recorded). */
export function appendRecord(mainRoot, record) {
  const path = recordPath(mainRoot);
  try {
    let dir = mainRoot;
    for (const segment of LOG_DIRECTORIES) {
      dir = join(dir, segment);
      ensureDirectory(dir);
    }
    const lockDir = join(dir, LOG_LOCK);
    withRecordLock(lockDir, () => {
      refuseLink(path, lstatOrNull(path));
      const fd = openSync(path, APPEND_FLAGS, 0o644);
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`);
      } finally {
        closeSync(fd);
      }
    });
  } catch (error) {
    const safeReason = String(error?.message ?? error).split(mainRoot).join('<repo>');
    throw new RecordError(`could not write the run record to ${RELATIVE_LOG_PATH}: ${safeReason}`);
  }
}
