/**
 * agreement.mjs — Group candidates by normalized change set, select winner.
 * Pure functions — no I/O.
 */

/**
 * Normalize content for comparison: collapse all whitespace runs to single space,
 * strip leading/trailing whitespace per line.
 */
export function normalizeContent(str) {
  return str
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .join('\n');
}

/**
 * Stable string key for one hunk: its line range plus normalized
 * replacement text. Two hunks that differ only in incidental whitespace
 * (indentation style, trailing spaces) key identically — the agreement
 * comparison is about whether candidates propose the SAME edit, not
 * byte-identical text (issue #279).
 */
function hunkKey(hunk) {
  return `${hunk.startLine}-${hunk.endLine}::${normalizeContent(hunk.replacement)}`;
}

/**
 * Produce a stable string key for a candidate's changeset, for grouping.
 * Operates on hunks (issue #279) — deliberately cheaper than the old
 * whole-file comparison it replaces: the key is built from just the
 * replacement text each hunk proposes, not the entire file each hunk lives
 * in, so agreement comparison stays cheap even as file size grows.
 *
 * @param {Array<{file: string, hunks: Array<{startLine, endLine, replacement}>}>} changes
 * @returns {string}
 */
export function changesetKey(changes) {
  // Sort by file path so order doesn't matter.
  const sorted = [...changes].sort((a, b) => a.file.localeCompare(b.file));
  return sorted
    .map(({ file, hunks }) => {
      const sortedHunks = [...hunks].sort((a, b) => a.startLine - b.startLine);
      return `${file}::${sortedHunks.map(hunkKey).join('|')}`;
    })
    .join('\x00');
}

/**
 * Group surviving candidates by their normalized changeset.
 * @param {Array<{index: number, changes: Array<{file, content}>, changedLines: number, passed: boolean}>} candidates
 * @returns {Map<string, Array<candidate>>} groups keyed by changesetKey
 */
export function groupByChangeset(candidates) {
  const groups = new Map();
  for (const c of candidates) {
    const key = changesetKey(c.changes);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return groups;
}

/**
 * Select the winning candidate.
 * Strategy:
 *   1. Find the largest agreement group.
 *   2. Within that group, pick the candidate with the smallest changedLines.
 *   3. If tie on size, prefer earliest index.
 *
 * @param {Map<string, Array<candidate>>} groups
 * @returns {{ winner: candidate, largestGroupSize: number, totalGroups: number }}
 */
export function selectWinner(groups) {
  if (groups.size === 0) return null;

  let largestGroup = null;
  let largestSize = 0;
  for (const group of groups.values()) {
    if (group.length > largestSize) {
      largestSize = group.length;
      largestGroup = group;
    }
  }

  // Pick smallest changed-line count within the largest group.
  const winner = largestGroup.reduce((best, c) => {
    if (c.changedLines < best.changedLines) return c;
    if (c.changedLines === best.changedLines && c.index < best.index) return c;
    return best;
  });

  return { winner, largestGroupSize: largestSize, totalGroups: groups.size };
}

/**
 * Determine if the result is all-divergent (every survivor is a singleton group
 * and n >= 3).
 * @param {Map<string, Array<candidate>>} groups
 * @param {number} n
 * @returns {boolean}
 */
export function isAllDivergent(groups, n) {
  if (n < 3) return false;
  for (const group of groups.values()) {
    if (group.length > 1) return false;
  }
  return true;
}
