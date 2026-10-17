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

import { readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  probeOwner,
  ownerStateFor,
  isContainedRelPath,
  resolveTarget,
  makeTempPath,
  writeInflightAtomic as writeFileAtomic,
  sweepStaleTemps,
  clearRecord,
} from '@adlc/core';

export {
  probeOwner,
  ownerStateFor,
  isContainedRelPath,
  resolveTarget,
  makeTempPath,
  writeFileAtomic,
  sweepStaleTemps,
  clearRecord,
};

export const INFLIGHT_BASENAME = 'adlc-review-calibration-inflight.json';
export const RECORD_FILENAME = INFLIGHT_BASENAME;
export const RECORD_VERSION = 1;

export function recordPathFor(gitDir) {
  return join(gitDir, RECORD_FILENAME);
}

export function isWellFormedEntry(f) {
  return (
    f !== null && typeof f === 'object' &&
    typeof f.file === 'string' && f.file.length > 0 &&
    typeof f.original === 'string' && typeof f.mutated === 'string'
  );
}

export function isWellFormed(record) {
  return (
    record !== null && typeof record === 'object' &&
    record.version === RECORD_VERSION &&
    Number.isInteger(record.pid) &&
    Array.isArray(record.files) && record.files.length > 0 &&
    record.files.every(isWellFormedEntry)
  );
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

export function writeRecord(recordPath, { pid = process.pid, files }) {
  writeFileAtomic(recordPath, JSON.stringify({ version: RECORD_VERSION, pid, files }));
}

export function readRecord(recordPath) {
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'));
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
      writeRecord(recordPath, { pid, files });
    },
    end() {
      clearRecord(recordPath);
    },
  };
}

/** A journal that records nothing, for library callers that manage safety themselves. */
export const NO_JOURNAL = Object.freeze({ begin() {}, end() {} });

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
  const owner = ownerStateFor(record.pid, selfPid, probe);
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
    sweepStaleTemps(target, { probe, selfPid });
    if (action !== 'restore') continue;
    writeFileAtomic(target, entry.original);
    restored.push(entry.file);
  }
  clearRecord(recordPath);
  return { status: 'recovered', pid: record.pid, restored };
}
