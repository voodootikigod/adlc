import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { LOCK_DIRECTORY } from './constants.mjs';
import { conflict, invalid, operational } from './errors.mjs';

const sleep = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

/**
 * `writeOwner` and `removeLock` are fault-injection seams defaulting to
 * writeFileSync and rmSync. Both failure paths they reach — a broken owner write,
 * and a cleanup that fails too — are only reachable through a real disk fault,
 * which no portable filesystem trick reproduces; and this package runs on the
 * Windows leg of the platform matrix, so a chmod-based test would not work there
 * either. Same pattern as planEditSession's runEditor.
 *
 * `makeLockDirectory` is the third, and it exists to make the RETRY BOUND
 * observable. `retries` is what makes a concurrent writer wait instead of failing
 * instantly, so it is behavior, not decoration — but the contended path throws
 * EEXIST from mkdir and reaches neither of the other two seams, so nothing could
 * count how many times it actually tried. The count could have drifted in either
 * direction and every test still passed.
 *
 * SCOPE, for all three: they are fault-injection points on specific operations,
 * NOT a filesystem abstraction. `makeLockDirectory` covers the lock-directory
 * creation INSIDE the retry loop and nothing else — the parent directory is
 * still created by mkdirSync directly, because it happens once, before the loop,
 * and is not part of the contention this seam exists to observe. Substituting a
 * virtual filesystem through these options will not intercept every call, and
 * they are not offered for that.
 */
export function acquireTicketLock(root = '.', {
  retries = 50, delayMs = 20, command = process.argv.join(' '), transactionId = null,
  writeOwner = writeFileSync, removeLock = rmSync, makeLockDirectory = mkdirSync,
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
      makeLockDirectory(path);
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
        try {
          removeLock(path, { recursive: true, force: true });
        } catch (cleanupError) {
          // Cleanup runs under exactly the conditions that broke the owner write
          // — I/O errors, quota, a transient Windows file lock — so it can fail
          // too. Swallowing that told the caller only that acquisition failed,
          // while a directory nobody holds a releasable handle to blocked every
          // later writer until someone found it by hand. Report BOTH causes and
          // the path, because this is the one failure a human must act on.
          throw operational(
            'LOCK_STRANDED',
            `could not acquire the ticket lock (${error.message}), and could not remove the partial lock at ${path} `
            + `(${cleanupError.message}). Remove that directory to unblock later ticket writers.`,
          );
        }
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
export function releaseTicketLock(lock, { removeLock = rmSync } = {}) {
  if (!lock?.path) return { released: false, reason: 'no-lock' };
  // Nothing on disk is NOT a stranded lock. readLockMetadata collapses every
  // read failure to null, ENOENT included, so an already-removed directory came
  // back as LOCK_STRANDED — which index.d.ts defines as "still on disk, a human
  // has to remove it". That is a false alarm pointed at an operator, and the
  // ordinary cleanup path (a test, another process, a prior release) hits it.
  if (!existsSync(lock.path)) return { released: false, reason: 'no-lock' };
  const owner = readLockMetadata(join(lock.path, 'owner.json'));
  if (!owner) return { released: false, reason: 'unverifiable', code: 'LOCK_STRANDED', path: lock.path };
  if (owner.pid !== lock.metadata?.pid || owner.startedAt !== lock.metadata?.startedAt) {
    return { released: false, reason: 'not-ours', path: lock.path };
  }
  try {
    removeLock(lock.path, { recursive: true, force: true });
  } catch (cause) {
    // NEVER throw from here. Release runs in `finally` blocks across the
    // transaction, migration, archive, fleet and sync paths, so throwing
    // replaces the operation's real outcome — and after a COMMITTED transaction
    // that is the worst possible answer: the caller reports failure for work
    // that durably applied, and a retry cannot tell whether it landed.
    //
    // Returning the failure keeps the primary result intact while still making
    // the stranded lock observable, which silence did not.
    return { released: false, reason: 'remove-failed', code: 'LOCK_STRANDED', path: lock.path, cause };
  }
  return { released: true };
}
