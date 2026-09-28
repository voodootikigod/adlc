// hollow-test/lib/diff-deletions.mjs
// The old side of a unified diff: which lines each changed file lost, and the
// path they were read from. `changedLinesFromDiff` in @adlc/core reports only
// the new side, so a hunk that deletes code is invisible to it.

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const OLD_HEADER_RE = /^--- (?:a\/(.+)|\/dev\/null)$/;
const NEW_HEADER_RE = /^\+\+\+ b\/(.+)$/;

/**
 * Per new-side path: `{ oldPath, lines }`, where `oldPath` is null for a file
 * the diff creates and `lines` holds 1-based OLD-side line numbers of every
 * deleted line.
 *
 * Hunk bodies are consumed by the counts in their `@@` header, so a deleted
 * line whose text begins with `--` (`---counter;`) is read as a deletion and
 * never mistaken for a file header.
 *
 * @param {string} diffText output of `git diff`
 * @returns {{ [file: string]: { oldPath: string|null, lines: Set<number> } }}
 */
export function deletedLinesFromDiff(diffText) {
  const result = {};
  let pendingOldPath = null;
  let current = null;
  let oldLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of String(diffText).split('\n')) {
    if (current && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith('\\')) continue;
      const marker = line[0];
      if (marker === '-') { current.lines.add(oldLine); oldLine++; oldLeft--; continue; }
      if (marker === '+') { newLeft--; continue; }
      oldLine++; oldLeft--; newLeft--;
      continue;
    }

    const oldHeader = line.match(OLD_HEADER_RE);
    if (oldHeader) { pendingOldPath = oldHeader[1] ?? null; continue; }

    const newHeader = line.match(NEW_HEADER_RE);
    if (newHeader) {
      current = { oldPath: pendingOldPath, lines: new Set() };
      result[newHeader[1]] = current;
      pendingOldPath = null;
      continue;
    }

    const hunk = line.match(HUNK_RE);
    if (hunk && current) {
      oldLine = parseInt(hunk[1], 10);
      oldLeft = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
      newLeft = hunk[3] === undefined ? 1 : parseInt(hunk[3], 10);
    }
  }
  return result;
}

/**
 * The old side's content for one file: '' when the diff creates it, the blob at
 * `base` otherwise, and null when that blob cannot be read — which every caller
 * must treat as "cannot prove this change is comment-only".
 *
 * @param {(args: string[]) => string} readGit runs git and returns stdout, throwing on failure
 * @param {string} base
 * @param {string|null} oldPath
 * @returns {string|null}
 */
export function readOldSource(readGit, base, oldPath) {
  if (oldPath === null) return '';
  try {
    return readGit(['cat-file', 'blob', `${base}:${oldPath}`]);
  } catch {
    return null;
  }
}
