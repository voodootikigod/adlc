// The in-flight mutation record: what hollow-test writes down before it edits a
// source file, so a run that dies mid-trial is cleaned up by the next one instead
// of leaving a live MUTANT in the working tree.
//
// Everything here is pure or injectable, because the properties that matter are
// the ones no integration test can reach: a liveness probe must not disturb the
// process it probes, EPERM needs a process owned by another user, and the
// recovery decision spans states that are painful to stage with real crashed
// processes. It also keeps the mutation gate affordable — that gate re-runs this
// package's tests once per mutant.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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

export const INFLIGHT_BASENAME = 'adlc-hollow-test-inflight.json';
export const RECORD_FILENAME = INFLIGHT_BASENAME;
export const RECORD_VERSION = 2;

/** Structural validation. A record we cannot read is litter, never an instruction. */
export function isWellFormed(record) {
  return (
    record !== null && typeof record === 'object' &&
    record.version === RECORD_VERSION &&
    typeof record.file === 'string' && record.file.length > 0 &&
    typeof record.original === 'string' &&
    typeof record.mutated === 'string'
  );
}

/**
 * What should a run do about the record it found?
 *
 *   restore  — the file on disk is still EXACTLY the mutant we wrote; put it back.
 *   none     — already the original; the record is litter, drop it.
 *   skip     — the owner may still be running; leave everything alone.
 *   conflict — neither original nor mutant, so the file has MOVED ON.
 *
 * `conflict` is what makes this safe. Restoring on "differs from original" alone
 * would overwrite whatever the developer did to that file after the crash — the
 * same data loss this feature exists to prevent, pointed the other way. On
 * conflict we must not write AND must not clear the record: that record holds the
 * only remaining copy of the original bytes.
 *
 * @returns {{action: 'restore'|'none'|'skip'|'conflict', reason: string|null}}
 */
export function decideRecovery({ ownerState, currentContent, record }) {
  if (ownerState !== 'dead') {
    return {
      action: 'skip',
      reason: ownerState === 'alive'
        ? 'another hollow-test run owns this record'
        : 'ownership of this record could not be established',
    };
  }
  if (currentContent === record.original) return { action: 'none', reason: null };
  if (currentContent === record.mutated) return { action: 'restore', reason: null };
  return { action: 'conflict', reason: 'the file matches neither the original nor the mutant' };
}

/**
 * Record that `relFile` is about to be mutated.
 *
 * THROWS on failure, and the caller must not mutate anything if it does. A
 * swallowed error here means the mutation proceeds with no way back — exactly the
 * SIGKILL case the record exists for, silently unprotected.
 */
export function writeRecord(recordPath, { pid, relFile, original, mutated }) {
  writeFileAtomic(
    recordPath,
    JSON.stringify({ version: RECORD_VERSION, pid, file: relFile, original, mutated }),
  );
}

export function readRecord(recordPath) {
  try {
    return JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return null;
  }
}

export function recordPathFor(gitDir) {
  return join(gitDir, RECORD_FILENAME);
}

/**
 * Recover a single in-flight mutation record if one exists.
 *
 * @param {{ recordPath?: string, repoRoot?: string, selfPid?: number, probe?: (pid: unknown) => 'alive'|'dead'|'unknown' }} [options]
 * @returns {{ status: string, file?: string, pid?: number|null, reason?: string|null }}
 */
export function recoverInflight({ recordPath, repoRoot, selfPid = process.pid, probe = probeOwner } = {}) {
  if (!recordPath || !existsSync(recordPath)) return { status: 'none' };
  const record = readRecord(recordPath);
  if (!isWellFormed(record)) {
    clearRecord(recordPath);
    return { status: 'discarded' };
  }
  const owner = ownerStateFor(record.pid, selfPid, probe);
  if (owner !== 'dead') return { status: 'skip', pid: record.pid };

  const target = resolveTarget(repoRoot, record.file);
  if (!target) return { status: 'conflict', pid: record.pid };
  sweepStaleTemps(target, { probe, selfPid });
  let current;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    return { status: 'conflict', pid: record.pid };
  }
  const decision = decideRecovery({ ownerState: owner, currentContent: current, record });
  if (decision.action === 'none') {
    clearRecord(recordPath);
    return { status: 'none' };
  }
  if (decision.action === 'restore') {
    writeFileAtomic(target, record.original);
    clearRecord(recordPath);
    return { status: 'recovered', file: record.file, pid: record.pid };
  }
  return { status: 'conflict', file: record.file, pid: record.pid, reason: decision.reason };
}

/**
 * Run fn while protecting target file with an in-flight record.
 */
export function withInflightRecord(recordPath, { pid = process.pid, relFile, original, mutated }, fn) {
  writeRecord(recordPath, { pid, relFile, original, mutated });
  try {
    return fn();
  } finally {
    clearRecord(recordPath);
  }
}
