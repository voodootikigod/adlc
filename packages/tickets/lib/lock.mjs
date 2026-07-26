import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCK_DIRECTORY } from './constants.mjs';
import { conflict, invalid, operational } from './errors.mjs';

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

/**
 * `writeOwner` is a fault-injection seam, defaulting to writeFileSync. The gap
 * between mkdir and the owner write is only reachable through a real ENOSPC or
 * quota, which no portable filesystem trick reproduces — and this package runs
 * on the Windows leg of the platform matrix, so a chmod-based test would not
 * work there either. Same pattern as planEditSession's runEditor.
 */
export function acquireTicketLock(root = '.', {
  retries = 50, delayMs = 20, command = process.argv.join(' '), transactionId = null, writeOwner = writeFileSync,
} = {}) {
  const path = join(root, LOCK_DIRECTORY);
  // Reject bad options BEFORE creating anything. Release requires a well-formed
  // owner file, so writing one that fails the shared check produced a lock this
  // module could acquire and then refuse to release — stranding the directory
  // and timing out every later writer. Throwing here leaves nothing behind.
  if (!isLockMetadata({ version: 1, pid: process.pid, hostname: '', startedAt: '', command, transactionId })) {
    throw invalid(
      'INVALID_LOCK_OPTIONS',
      'acquireTicketLock requires a string command and a string-or-null transactionId; '
      + 'a lock written from other values could not be released by its own owner.',
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // Tracks whether THIS attempt created the directory, so cleanup below can
    // never remove a lock that belongs to somebody else.
    let created = false;
    try {
      // Build and serialize the owner BEFORE mkdir: a hostname() or JSON failure
      // must not leave a directory behind, and there is nothing to undo yet.
      const metadata = { version: 1, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), command, transactionId };
      const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
      mkdirSync(path);
      created = true;
      writeOwner(join(path, 'owner.json'), serialized, { flag: 'wx' });
      return { path, metadata };
    } catch (error) {
      // Acquisition is two filesystem steps, and the gap between them was not
      // atomic: ENOSPC or a quota on the owner write left `.adlc/tickets.lock`
      // present with NO owner file, and no lock object was returned for anyone
      // to release. Every later writer then saw EEXIST and timed out. Undo only
      // our own half-made lock, best-effort, without masking the real error.
      if (created) {
        try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort — the original error matters more */ }
      }
      if (error.code !== 'EEXIST') throw operational('LOCK_FAILED', `cannot acquire ticket lock: ${error.message}`);
      if (attempt < retries) sleep(delayMs);
    }
  }
  throw conflict('LOCK_TIMEOUT', `could not acquire ${LOCK_DIRECTORY}; another ticket writer is running`, readTicketLock(root));
}

/**
 * The single definition of a well-formed lock owner.
 *
 * `owner.json` is attacker-controlled in an untrusted workspace, and index.d.ts
 * publishes TicketLockMetadata with a numeric pid and version — so every path
 * that touches the file has to agree on what a valid one looks like. Three
 * successive rounds of review found a different pair disagreeing:
 *
 *   1. readTicketLock only JSON-parsed, so the valid JSON string "stale"
 *      satisfied the compiler and crashed the caller on `.pid`.
 *   2. Hardening that left releaseTicketLock parsing the same file and
 *      dereferencing it unvalidated — `null` made `.pid` throw, from inside the
 *      `finally` blocks that masks the real error and strands the lock.
 *   3. Hardening THAT left acquisition writing owner files its own release path
 *      would then reject, so a lock could be taken and never released.
 *
 * Hence one predicate, asserted by acquisition before any mkdir and applied by
 * both readers afterwards. A lock this module creates is always releasable by
 * this module, which separate checks could not guarantee.
 */
function isLockMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.version !== 1) return false;
  if (!Number.isInteger(value.pid)) return false;
  if (typeof value.hostname !== 'string' || typeof value.startedAt !== 'string') return false;
  if (typeof value.command !== 'string') return false;
  if (value.transactionId !== null && typeof value.transactionId !== 'string') return false;
  return true;
}

/** Parse and validate an owner file. Never throws: one caller runs inside
 *  `finally` blocks where a throw would mask the real error. */
function readLockMetadata(path) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
  return isLockMetadata(parsed) ? parsed : null;
}

/** The lock owner's metadata, or null when unlocked, unreadable or malformed. */
export function readTicketLock(root = '.') {
  return readLockMetadata(join(root, LOCK_DIRECTORY, 'owner.json'));
}

/**
 * Release the lock, but only if we still own it.
 *
 * Shares ONE validator with readTicketLock. Hardening the read alone left this
 * path parsing the same attacker-controlled file and dereferencing the result
 * unvalidated: `owner.json` becoming the valid JSON `null` after acquisition
 * made `.pid` throw. Release is called from `finally` blocks all over the
 * transaction, migration, archive, fleet and sync paths, so that TypeError
 * would replace the operation's real result or error AND leave the lock
 * directory behind, timing out every later writer.
 *
 * An unreadable or unrecognized owner file therefore means "not demonstrably
 * ours", and the directory is left alone — the same fail-closed answer
 * readTicketLock gives.
 */
export function releaseTicketLock(lock) {
  if (!lock?.path) return;
  const owner = readLockMetadata(join(lock.path, 'owner.json'));
  if (!owner) return;
  if (owner.pid !== lock.metadata?.pid || owner.startedAt !== lock.metadata?.startedAt) return;
  rmSync(lock.path, { recursive: true, force: true });
}
