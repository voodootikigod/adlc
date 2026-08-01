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

import {
  openSync, closeSync, writeFileSync, renameSync, unlinkSync,
  readFileSync, existsSync, lstatSync, statSync, chmodSync, realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

export const INFLIGHT_BASENAME = 'adlc-hollow-test-inflight.json';
export const RECORD_VERSION = 2;

/**
 * Is the process that owns a record still running?
 *
 * TRI-STATE on purpose. "Not definitely alive" is not "definitely gone", and only
 * the latter may authorise overwriting a file: treating an unrecognised probe
 * failure as death is how recovery would clobber a run that is still working.
 *
 * Signal 0 performs the existence and permission checks and delivers NOTHING.
 * Any other signal number is delivered for real, so a probe that drifted to 1
 * would SIGHUP the very run it was checking.
 *
 * @param {unknown} pid
 * @param {(pid: number, signal: number) => void} [kill]
 * @returns {'alive'|'dead'|'unknown'}
 */
export function probeOwner(pid, kill = process.kill.bind(process)) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    kill(pid, 0);
    return 'alive';
  } catch (err) {
    if (err.code === 'ESRCH') return 'dead';
    // Exists, but owned by another user — alive, and none of our business.
    if (err.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Ownership state for a record, accounting for the record being OURS.
 *
 * A record carrying this process's own pid cannot belong to a running owner:
 * recovery happens at startup, before this process writes any record. It is a
 * corpse from an earlier process whose pid the OS has since handed to us. Probing
 * it would answer 'alive' — we are alive — and recovery would be skipped forever,
 * leaving the stranded mutant and the dirty-tree refusal in place permanently.
 *
 * Split out because a pid collision cannot be staged from an integration test.
 *
 * @returns {'alive'|'dead'|'unknown'}
 */
export function ownerStateFor(recordPid, selfPid, probe = probeOwner) {
  if (recordPid === selfPid) return 'dead';
  return probe(recordPid);
}

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
 * Is this a repo-relative path that stays inside the repo?
 *
 * The record names a WRITE TARGET. A record copied from another checkout, a
 * relocated git dir, or one planted by anything able to write the git dir could
 * otherwise direct that write anywhere on disk. Storing the path repo-relative
 * and re-deriving it means a record only ever addresses its own repository.
 */
export function isContainedRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (isAbsolute(relPath)) return false;
  if (relPath.split(/[\\/]/).includes('..')) return false;
  return true;
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
 * An unpredictable temp path next to `path`.
 *
 * The name used to be `<target>.tmp-<pid>`, which is guessable: anything able to
 * create that name first turns the "durable" write into a write THROUGH a symlink,
 * clobbering its destination and then renaming the symlink over the real target.
 * Randomising the name removes the target; opening with 'wx' (O_CREAT|O_EXCL)
 * removes the follow.
 */
export function makeTempPath(path) {
  return `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
}

/**
 * Replace a file's contents ATOMICALLY.
 *
 * Atomic, deliberately NOT power-loss durable, and the distinction is the whole
 * design. The failure modes this feature exists for — SIGKILL, an OOM kill, a tool
 * or CI timeout — kill the PROCESS, not the page cache: the kernel still writes
 * those bytes out. fsync only buys anything against power loss or a kernel panic,
 * neither of which is what strands mutants, and chasing it here bought three
 * review findings (a swallowed directory-sync failure, a short write, and a
 * half-durable clear) in exchange for a guarantee a mutation-testing helper has no
 * business making.
 *
 * What IS needed is atomicity: a process killed mid-write must never leave a
 * TRUNCATED source file. Writing to a temp file and renaming gives exactly that,
 * since rename is atomic within a filesystem.
 *
 * PRESERVES THE TARGET'S MODE, because rename installs a new inode — without it a
 * restored executable would silently drop from 0755 to 0644.
 *
 * The temp path is randomised and opened O_EXCL: a guessable `<target>.tmp-<pid>`
 * is a name anything with write access can create first, turning this into a write
 * THROUGH their symlink and then a rename of that symlink over the real target.
 */
export function writeFileAtomic(path, contents, { tempPath = null } = {}) {
  let mode = null;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch { /* new file: take the default */ }

  const tmp = tempPath ?? makeTempPath(path);
  // 'wx' is O_CREAT|O_EXCL: refuses an existing path rather than following it.
  const fd = openSync(tmp, 'wx');
  let created = true;
  try {
    closeSync(fd);
    // writeFileSync loops internally, so a short write cannot silently truncate.
    writeFileSync(tmp, contents);
    if (mode !== null) chmodSync(tmp, mode);
    renameSync(tmp, path);
    created = false; // renamed away; nothing left to clean up
  } finally {
    // Never leave litter: an orphaned *.tmp-* is untracked, and hollow-test
    // refuses to run on a dirty tree — so a failure here would wedge the NEXT run.
    if (created) {
      try { unlinkSync(tmp); } catch { /* nothing better to do */ }
    }
  }
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

export function clearRecord(recordPath) {
  try {
    if (existsSync(recordPath)) unlinkSync(recordPath);
  } catch { /* best effort — a leftover record is re-evaluated, never obeyed blindly */ }
}

/**
 * Resolve a record's target to an absolute path, refusing anything that escapes
 * the repo or reaches it through a symlink.
 *
 * @returns {string|null} absolute path, or null if it must not be written
 */
export function resolveTarget(repoRoot, relFile) {
  if (!isContainedRelPath(relFile)) return null;
  const absolute = resolve(repoRoot, relFile);
  try {
    // Containment is checked against REAL paths, and the parent is resolved so
    // that EVERY intermediate component is followed. Checking only the leaf let a
    // symlinked directory anywhere in the path smuggle the write outside the
    // repo, while lstat on the leaf still reported an ordinary file.
    const rootReal = realpathSync(repoRoot);
    const parentReal = realpathSync(dirname(absolute));
    const rel = relative(rootReal, join(parentReal, basename(absolute)));
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    // A symlink AT the target is likewise an arbitrary write.
    if (lstatSync(absolute).isSymbolicLink()) return null;
  } catch {
    return null; // missing target, or a path we cannot resolve: never write it
  }
  return absolute;
}

export function recordPathFor(gitDir) {
  return join(gitDir, INFLIGHT_BASENAME);
}
