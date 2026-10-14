// bind-files.mjs — the tree identity a recorded flail-check vouches for (#759).
// `--files a,b,c` is hashed with the same helper `gate-manifest record --files`
// uses, so the P4 runner re-hashes both markers with one rule.

import { hashFiles } from '@adlc/core';
import { parseFileList } from '@adlc/gate-manifest/lib/record.mjs';

/**
 * @param {string|undefined} rawFiles  the raw --files value
 * @param {(paths: string[]) => Record<string, string|null>} [hash]
 * @returns {{ ok: true, files: Record<string, string> | null }
 *         | { ok: false, error: string }}
 *   `files` is null when --files was not given (nothing to bind). An empty list
 *   or any unreadable path is an error: a binding that covers nothing, or a
 *   file that cannot be hashed, must never become evidence.
 */
export function bindFiles(rawFiles, hash = hashFiles) {
  if (rawFiles === undefined) return { ok: true, files: null };
  const paths = parseFileList(rawFiles);
  if (paths.length === 0) return { ok: false, error: '--files named no paths' };
  const hashes = hash(paths);
  const unreadable = paths.filter((path) => typeof hashes[path] !== 'string');
  if (unreadable.length > 0) {
    return { ok: false, error: `--files cannot read: ${unreadable.join(', ')}` };
  }
  return { ok: true, files: hashes };
}
