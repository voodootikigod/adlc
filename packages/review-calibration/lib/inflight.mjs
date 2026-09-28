// review-calibration/lib/inflight.mjs
// Crash-safe planting. Plants are written into real source files while an
// external review command runs for minutes inside spawnSync, and a process
// blocked in spawnSync runs no signal handler: a SIGTERM (CI cancel, docker
// stop, kill) or SIGKILL ends it with the plants still on disk. So the
// guarantee is not "a handler restores them" but:
//
//   1. every plant/restore write is atomic, so no source file is ever left
//      truncated, and
//   2. before any file is planted, an in-flight record of its original and
//      planted contents is written to the git dir; the next run restores from
//      it before its dirty-tree check.
//
// Recovery only ever writes a file that still holds EXACTLY the planted
// content. Anything else means the file moved on after the crash, and the
// record — the only remaining copy of the original — is kept for a human.

import {
  openSync, closeSync, writeFileSync, fchmodSync, renameSync, unlinkSync,
  readFileSync, existsSync, lstatSync, statSync, realpathSync, readdirSync,
} from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

export const INFLIGHT_BASENAME = 'adlc-review-calibration-inflight.json';
export const RECORD_VERSION = 1;

export function recordPathFor(gitDir) {
  return join(gitDir, INFLIGHT_BASENAME);
}

/**
 * Replace a file's contents atomically: write a temp file beside it, then
 * rename over it. A process killed mid-write leaves the old file intact, never
 * a truncated one. Follows a symlink (so the link survives), preserves the
 * target's mode, and opens the unpredictable temp name O_EXCL so it cannot be
 * pre-created as a symlink elsewhere.
 */
export function writeFileAtomic(path, contents) {
  let realPath = path;
  try {
    if (lstatSync(path).isSymbolicLink()) realPath = realpathSync(path);
  } catch { /* absent: the write below reports it or creates it */ }

  let mode = null;
  try {
    mode = statSync(realPath).mode & 0o7777;
  } catch { /* new file: default mode */ }

  const tmp = `${realPath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  const fd = openSync(tmp, 'wx');
  let open = true;
  let renamed = false;
  try {
    writeFileSync(fd, contents);
    if (mode !== null) fchmodSync(fd, mode);
    closeSync(fd);
    open = false;
    renameSync(tmp, realPath);
    renamed = true;
  } finally {
    if (open) { try { closeSync(fd); } catch { /* already failing */ } }
    if (!renamed) { try { unlinkSync(tmp); } catch { /* nothing to clean */ } }
  }
}

/**
 * Is the process that owns a record still running? Tri-state: only 'dead'
 * authorises recovery. Signal 0 probes without delivering anything.
 *
 * @returns {'alive'|'dead'|'unknown'}
 */
export function probeOwner(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (err.code === 'ESRCH') return 'dead';
    if (err.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/** A record's target must be a repo-relative path that stays inside the repo. */
export function isContainedRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (isAbsolute(relPath)) return false;
  return !relPath.split(/[\\/]/).includes('..');
}

export function isWellFormed(record) {
  return (
    record !== null && typeof record === 'object' &&
    record.version === RECORD_VERSION &&
    Number.isInteger(record.pid) &&
    Array.isArray(record.files) && record.files.length > 0 &&
    record.files.every((f) =>
      f !== null && typeof f === 'object' &&
      typeof f.file === 'string' && f.file.length > 0 &&
      typeof f.original === 'string' && typeof f.mutated === 'string')
  );
}

/**
 * Resolve a record entry to the absolute path it may write, or null when it
 * escapes the repository (directly or through a symlink) or no longer exists.
 */
export function resolveTarget(repoRoot, relFile) {
  if (!isContainedRelPath(relFile)) return null;
  try {
    const rootReal = realpathSync(repoRoot);
    const targetReal = realpathSync(resolve(repoRoot, relFile));
    const rel = relative(rootReal, targetReal);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return targetReal;
  } catch {
    return null;
  }
}

/**
 * What to do with one recorded file, given what is on disk now.
 *
 * @returns {'restore'|'none'|'conflict'}
 */
export function decideFile(currentContent, entry) {
  if (currentContent === entry.original) return 'none';
  if (currentContent === entry.mutated) return 'restore';
  return 'conflict';
}

function readCurrent(target) {
  if (target === null) return null;
  try {
    return readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Journal bound to one record path: `begin` records the files about to be
 * planted and THROWS if it cannot (nothing may be planted unprotected); `end`
 * removes the record once every file is restored.
 */
export function createJournal({ recordPath, repoRoot, pid = process.pid }) {
  return {
    begin(entries) {
      const files = entries.map(({ absolutePath, original, mutated }) => {
        const file = relative(repoRoot, absolutePath);
        if (!isContainedRelPath(file)) {
          throw new Error(`refusing to plant outside the repository: ${absolutePath}`);
        }
        return { file, original, mutated };
      });
      writeFileAtomic(recordPath, JSON.stringify({ version: RECORD_VERSION, pid, files }));
    },
    end() {
      clearRecord(recordPath);
    },
  };
}

/** A journal that records nothing, for library callers that manage safety themselves. */
export const NO_JOURNAL = Object.freeze({ begin() {}, end() {} });

export function clearRecord(recordPath) {
  try {
    if (existsSync(recordPath)) unlinkSync(recordPath);
  } catch { /* a leftover record is re-evaluated next run, never obeyed blindly */ }
}

function readRecord(recordPath) {
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Remove `<file>.tmp-<pid>-*` files beside `target` whose writer is dead. A
 * process killed inside writeFileAtomic leaves one, and as an untracked file it
 * would fail every later run's dirty-tree check.
 */
export function sweepStaleTemps(target, probe = probeOwner) {
  const prefix = `${basename(target)}.tmp-`;
  let entries;
  try {
    entries = readdirSync(dirname(target));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const pid = Number.parseInt(entry.slice(prefix.length).split('-')[0], 10);
    if (probe(pid) !== 'dead') continue;
    try { unlinkSync(join(dirname(target), entry)); } catch { /* already gone */ }
  }
}

/**
 * Restore files an interrupted run left planted.
 *
 * Outcomes:
 *   none      — no record
 *   discarded — a record that is not well formed; litter, never an instruction
 *   skip      — the owning process may still be running; nothing touched
 *   conflict  — a recorded file is neither original nor planted (or cannot be
 *               resolved inside the repo); nothing written, record kept
 *   recovered — every planted file restored, record removed
 *
 * @returns {{status:string, pid?:number, restored?:string[], conflicts?:string[]}}
 */
export function recoverInflight({ recordPath, repoRoot, selfPid = process.pid, probe = probeOwner }) {
  if (!existsSync(recordPath)) return { status: 'none' };
  const record = readRecord(recordPath);
  if (!isWellFormed(record)) {
    clearRecord(recordPath);
    return { status: 'discarded' };
  }
  const owner = record.pid === selfPid ? 'dead' : probe(record.pid);
  if (owner !== 'dead') return { status: 'skip', pid: record.pid };

  const plan = record.files.map((entry) => {
    const target = resolveTarget(repoRoot, entry.file);
    const current = readCurrent(target);
    const action = current === null ? 'conflict' : decideFile(current, entry);
    return { entry, target, action };
  });
  const conflicts = plan.filter((p) => p.action === 'conflict').map((p) => p.entry.file);
  if (conflicts.length > 0) return { status: 'conflict', pid: record.pid, conflicts };

  const restored = [];
  for (const { entry, target, action } of plan) {
    sweepStaleTemps(target, probe);
    if (action !== 'restore') continue;
    writeFileAtomic(target, entry.original);
    restored.push(entry.file);
  }
  clearRecord(recordPath);
  return { status: 'recovered', pid: record.pid, restored };
}
