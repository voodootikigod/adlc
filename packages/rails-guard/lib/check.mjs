// Orchestrate the two checks (rail-edit + suppression) and produce a
// unified violations list plus a summary record.

import { resolveRailGlobs, checkRailEdits } from './rails.mjs';
import { parseAddedLines, findSuppressions, isMarkerAllowed } from './suppressions.mjs';

/**
 * Run both checks.
 *
 * @param {object} opts
 * @param {string[]}  opts.changedFiles  - files changed relative to base
 * @param {string}    opts.diffText      - raw git diff output
 * @param {string[]}  opts.cliRails      - globs from --rails flags (may be empty)
 * @param {object|null} opts.ticket      - loaded ticket object or null
 *
 * @returns {{
 *   railGlobs: string[],
 *   railGlobError: string | null,
 *   violations: Array,
 *   railsDiffEmpty: boolean,
 *   suppressionsClean: boolean,
 * }}
 *
 * Violation shape:
 *   { file, type: 'rail-edit', globs }          — froze path was edited
 *   { file, type: 'suppression', marker, lineNo }  — unapproved marker added
 */
export function runChecks({ changedFiles, diffText, cliRails, ticket }) {
  const { globs: railGlobs, error: railGlobError } = resolveRailGlobs(cliRails, ticket);

  const violations = [];

  // CHECK 1: rail edits
  if (railGlobs.length > 0) {
    const railEdits = checkRailEdits(changedFiles, railGlobs);
    violations.push(...railEdits);
  }

  const railsDiffEmpty = violations.filter((v) => v.type === 'rail-edit').length === 0;

  // CHECK 2: suppression markers in added lines
  const addedLines = parseAddedLines(diffText);
  const suppressions = findSuppressions(addedLines);
  const ticketBody = ticket?.body ?? '';

  for (const s of suppressions) {
    if (!isMarkerAllowed(s.marker, ticketBody)) {
      violations.push({
        file: s.file,
        type: 'suppression',
        marker: s.marker,
        lineNo: s.lineNo,
        line: s.content,
      });
    }
  }

  const suppressionsClean = violations.filter((v) => v.type === 'suppression').length === 0;

  return {
    railGlobs,
    railGlobError,
    violations,
    railsDiffEmpty,
    suppressionsClean,
  };
}
