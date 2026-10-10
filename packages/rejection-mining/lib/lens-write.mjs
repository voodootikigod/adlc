// lens-write.mjs — the one place a lens file reaches disk (issue #746).
//
// Lens files are curated after `--write`, so placing one must never replace a
// file the operator did not ask to replace — including one that appeared
// between a pre-check and the write. The content lands in a sibling temp file
// first, then:
//   - without `force`, `linkSync` publishes it under the final name. A hard
//     link is an atomic no-replace create: it fails with EEXIST if anything is
//     already there, which is reported as 'skip-exists' rather than thrown.
//   - with `force`, `renameSync` replaces whatever is there, atomically.
// The temp file itself is created exclusively (`wx`: O_CREAT|O_EXCL, which
// never follows a symlink and never truncates an existing file) under an
// unpredictable name, so a pre-planted entry in a shared directory cannot
// redirect the write (a collision on 64 random bits is reported as a write
// failure, not retried). The temp file is removed on every path, including a
// throw.

import { closeSync, existsSync, linkSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { writeDecision } from './lens.mjs';

/**
 * An unpredictable temp-name token: 16 hex characters from the CSPRNG. Two
 * writers in the same directory cannot guess each other's temp path, and a
 * pre-planted entry under a guessed name cannot be hit.
 * @returns {string}
 */
export function tempToken() {
  return randomBytes(8).toString('hex');
}

/**
 * The sibling temp path for `path` under `token` (pure).
 * @param {string} path
 * @param {string} token
 * @returns {string}
 */
export function tempPathFor(path, token) {
  return `${path}.tmp-${token}`;
}

/**
 * Create `tmp` exclusively and write ALL of `content` into it. Throws EEXIST
 * when any directory entry (file, symlink, directory) already sits at `tmp`;
 * the entry is never followed, truncated or replaced. Any failure after the
 * create — a non-string content, a short or failing write — removes `tmp`
 * before rethrowing, so a failed write never leaves an artifact and never
 * reaches the publish step.
 * @param {string} tmp
 * @param {string} content
 */
export function writeExclusive(tmp, content) {
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    if (typeof content !== 'string') throw new TypeError(`lens content must be a string, got ${typeof content}`);
    const bytes = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < bytes.length) {
      const n = writeSync(fd, bytes, written, bytes.length - written);
      if (!(n > 0)) throw new Error(`short write to ${tmp}: ${written} of ${bytes.length} bytes`);
      written += n;
    }
  } catch (err) {
    closeSync(fd);
    removeQuietly(tmp);
    throw err;
  }
  closeSync(fd);
}

/** Remove our own temp file; it may already be gone (renamed away). */
function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // already gone — nothing to clean
  }
}

/**
 * @param {string} path
 * @param {string} content
 * @param {{force: boolean}} o
 * @returns {'written'|'skip-exists'}
 */
export function placeLens(path, content, { force }) {
  // Fast path: an existing lens is skipped before any byte is written, so
  // skipping needs no write access to the directory and never leaves a temp
  // file beside a curated lens. The link below is the race-safe backstop for a
  // file that appears after this check.
  if (writeDecision({ exists: existsSync(path), force }) === 'skip-exists') return 'skip-exists';
  const tmp = tempPathFor(path, tempToken());
  writeExclusive(tmp, content);
  try {
    if (force) {
      renameSync(tmp, path);
      return 'written';
    }
    try {
      linkSync(tmp, path);
    } catch (err) {
      if (err?.code === 'EEXIST') return 'skip-exists';
      throw err;
    }
    return 'written';
  } finally {
    removeQuietly(tmp);
  }
}
