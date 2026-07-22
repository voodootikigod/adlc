/**
 * hunks.mjs — apply and measure structured line-range edits.
 * Pure: no I/O.
 *
 * A hunk replaces the INCLUSIVE 1-indexed line range [startLine, endLine] of
 * a file's content with `replacement`. Pure insertion (no deletion) is
 * represented as endLine === startLine - 1 (a zero-length range) — insert
 * `replacement` immediately before the original startLine.
 */

/**
 * Validate one hunk's shape and bounds against a known line count.
 * Returns null when valid, or a string reason when not.
 */
function validateHunk(hunk, totalLines) {
  if (!hunk || typeof hunk !== 'object') return 'hunk must be an object';
  const { startLine, endLine, replacement } = hunk;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return 'startLine and endLine must be integers';
  }
  if (startLine < 1) return `startLine must be >= 1, got ${startLine}`;
  if (endLine < startLine - 1) return `endLine (${endLine}) must be >= startLine - 1 (${startLine - 1})`;
  if (endLine > totalLines) return `endLine (${endLine}) exceeds file length (${totalLines} lines)`;
  if (typeof replacement !== 'string') return 'replacement must be a string';
  return null;
}

/**
 * Apply a set of non-overlapping hunks to file content.
 *
 * @param {string} content - original file content
 * @param {Array<{startLine:number, endLine:number, replacement:string}>} hunks
 * @returns {{ok:true, content:string} | {ok:false, error:string}}
 */
export function applyHunks(content, hunks) {
  if (!Array.isArray(hunks) || hunks.length === 0) {
    return { ok: false, error: 'hunks must be a non-empty array' };
  }
  const lines = content.split('\n');
  const totalLines = lines.length;

  for (const hunk of hunks) {
    const reason = validateHunk(hunk, totalLines);
    if (reason) return { ok: false, error: reason };
  }

  // Non-overlap check: sort ascending by startLine, each next hunk's start
  // must be strictly after the previous hunk's end.
  const ascending = [...hunks].sort((a, b) => a.startLine - b.startLine);
  for (let i = 1; i < ascending.length; i++) {
    if (ascending[i].startLine <= ascending[i - 1].endLine) {
      return { ok: false, error: `hunks overlap at line ${ascending[i].startLine}` };
    }
  }

  // Apply from the last hunk backward so earlier line numbers are never
  // shifted by edits already applied.
  const descending = [...hunks].sort((a, b) => b.startLine - a.startLine);
  let result = lines;
  for (const hunk of descending) {
    const before = result.slice(0, hunk.startLine - 1);
    const after = result.slice(hunk.endLine);
    const replacementLines = hunk.replacement === '' ? [] : hunk.replacement.split('\n');
    result = [...before, ...replacementLines, ...after];
  }

  return { ok: true, content: result.join('\n') };
}

/**
 * Changed-line count for one hunk: the larger of the original span removed
 * and the replacement span inserted (a pure insert or pure delete still
 * counts as a real edit; a same-size replacement counts its own size).
 */
export function hunkChangedLines(hunk) {
  const originalSpan = Math.max(0, hunk.endLine - hunk.startLine + 1);
  const replacementSpan = hunk.replacement === '' ? 0 : hunk.replacement.split('\n').length;
  return Math.max(originalSpan, replacementSpan);
}

/**
 * Total changed lines across every hunk in every file of a candidate's
 * changeset. Self-describing from the hunks alone — no original content
 * needed (unlike the old whole-file diff, which had to re-derive this by
 * comparing full before/after strings).
 *
 * @param {Array<{file:string, hunks:Array}>} changes
 * @returns {number}
 */
export function totalHunkChangedLines(changes) {
  let total = 0;
  for (const { hunks } of changes) {
    for (const hunk of hunks ?? []) {
      total += hunkChangedLines(hunk);
    }
  }
  return total;
}
