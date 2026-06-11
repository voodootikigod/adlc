// Suppression-marker detection in git diffs.
// A "suppression marker" is a test/lint escape hatch that weakens coverage.
// Markers are allowed only when the ticket body explicitly declares them.

/** All suppression patterns to detect. */
export const SUPPRESSION_MARKERS = [
  '.skip(',
  '.only(',
  'xfail',
  '@ts-ignore',
  '@ts-expect-error',
  'eslint-disable',
  '# noqa',
  '#[ignore]',
];

/**
 * Parse added lines from a unified diff string.
 * Returns [ { file, lineNo, content } ] for each added line.
 * Lines starting with '+++' (diff header) are excluded.
 */
export function parseAddedLines(diffText) {
  const lines = diffText.split('\n');
  const results = [];
  let currentFile = null;
  let newLineNo = 0;

  for (const raw of lines) {
    // New file header: +++ b/path/to/file
    if (raw.startsWith('+++ ')) {
      const fileMatch = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      currentFile = fileMatch ? fileMatch[1] : null;
      newLineNo = 0;
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLineNo = parseInt(m[1], 10) - 1;
      continue;
    }

    // Context line
    if (raw.startsWith(' ')) {
      newLineNo++;
      continue;
    }

    // Removed line — does not count in new side
    if (raw.startsWith('-')) {
      continue;
    }

    // Added line
    if (raw.startsWith('+')) {
      newLineNo++;
      if (currentFile !== null) {
        results.push({ file: currentFile, lineNo: newLineNo, content: raw.slice(1) });
      }
      continue;
    }
  }

  return results;
}

/**
 * Find suppression markers in added lines.
 * Returns [ { file, lineNo, marker, content } ].
 */
export function findSuppressions(addedLines) {
  const found = [];
  for (const { file, lineNo, content } of addedLines) {
    for (const marker of SUPPRESSION_MARKERS) {
      if (content.includes(marker)) {
        found.push({ file, lineNo, marker, content });
        break; // one violation per line is enough
      }
    }
  }
  return found;
}

/**
 * Determine whether a suppression marker is allowed by the ticket body.
 * The ticket body must contain `allow-suppression: <marker>` (exact match,
 * case-sensitive) to permit the marker.
 *
 * @param {string} marker
 * @param {string} ticketBody
 * @returns {boolean}
 */
export function isMarkerAllowed(marker, ticketBody) {
  if (!ticketBody) return false;
  const needle = `allow-suppression: ${marker}`;
  return ticketBody.includes(needle);
}
