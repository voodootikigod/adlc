/**
 * diff.mjs — Line-count diff between original and new content.
 * Pure, no subprocess required.
 */

/**
 * Count lines that differ between original and updated content.
 * Simple: count lines that are changed (not in common).
 * Uses a naive diff approach: lines unique to either side = changed.
 */
export function countChangedLines(original, updated) {
  const origLines = original.split('\n');
  const newLines = updated.split('\n');

  // Count lines that differ (simple set-based approach).
  // For each line position, if the text differs it's a changed line.
  const maxLen = Math.max(origLines.length, newLines.length);
  let changed = 0;
  for (let i = 0; i < maxLen; i++) {
    if (origLines[i] !== newLines[i]) changed++;
  }
  return changed;
}

/**
 * Compute total changed lines across all files in a candidate's changeset,
 * relative to the snapshot.
 * @param {Array<{file, content}>} changes
 * @param {{ [file]: string }} snapshot
 * @returns {number}
 */
export function totalChangedLines(changes, snapshot) {
  let total = 0;
  for (const { file, content } of changes) {
    const original = snapshot[file] ?? '';
    total += countChangedLines(original, content);
  }
  return total;
}
