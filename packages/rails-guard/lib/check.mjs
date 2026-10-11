// Orchestrate the two checks (rail-edit + suppression) and produce a
// unified violations list plus a summary record.

import { resolveRailSet, railOwners, checkRailEdits } from './rails.mjs';
import { parseAddedLines, findSuppressions, isMarkerAllowed } from './suppressions.mjs';

/**
 * Run both checks.
 *
 * @param {object} opts
 * @param {string[]}  opts.changedFiles  - files changed relative to base
 * @param {string}    opts.diffText      - raw git diff output
 * @param {string[]}  opts.cliRails      - globs from --rails flags (may be empty)
 * @param {object|null} opts.ticket      - the --ticket ticket or null. Selects ONLY
 *        whose `allow-suppression` declarations apply; it does not decide which rails
 *        exist (#1050).
 * @param {object[]}  [opts.tickets]     - every ticket in the store; the rail set is
 *        the union over the non-completed ones (see resolveRailSet). Defaults to
 *        `[ticket]` so a caller that only has one ticket keeps the old behaviour.
 * @param {(file: string, lineNo: number) => boolean} [opts.isFenced]
 *        Authoritative `.mdx` fenced-code predicate (see findSuppressions). Omitted
 *        in pure/unit contexts, where it fails closed.
 * @param {(file: string) => {before: string, after: string} | null} [opts.resolveContents]
 *        Manifest revision accessor for the #228 version-only rail exemption.
 *        Omitted in pure/unit contexts, where the exemption is simply off.
 *
 * @returns {{
 *   railGlobs: string[],
 *   railSources: Array<{glob: string, owner: string|null}>,
 *   railGlobError: string | null,
 *   violations: Array,
 *   railsDiffEmpty: boolean,
 *   suppressionsClean: boolean,
 *   sanctionedAdditions: string[],
 * }}
 *
 * Violation shape:
 *   { file, type: 'rail-edit', globs, ownerTicket }  — frozen path was edited; ownerTicket
 *                                                      names the declaring ticket (null for --rails)
 *   { file, type: 'suppression', marker, lineNo }    — unapproved marker added
 */
export function runChecks({ changedFiles, diffText, cliRails, ticket, tickets, isFenced, resolveContents, sanctionedAdditions }) {
  const { rails: railSources, error: railGlobError } = resolveRailSet({
    cliRails: cliRails ?? [],
    ticket: ticket ?? null,
    tickets: tickets ?? (ticket ? [ticket] : []),
  });
  const railGlobs = [...new Set(railSources.map((r) => r.glob))];

  const violations = [];
  let sanctionedAdditionsOut = [];

  // CHECK 1: rail edits
  if (railGlobs.length > 0) {
    const railEdits = checkRailEdits(changedFiles, railGlobs, resolveContents, sanctionedAdditions ?? null, railOwners(railSources));
    violations.push(...railEdits.violations);
    sanctionedAdditionsOut = [...new Set(railEdits.sanctioned.map((s) => s.file))].sort();
  }

  const railsDiffEmpty = violations.filter((v) => v.type === 'rail-edit').length === 0;

  // CHECK 2: suppression markers in added lines
  const addedLines = parseAddedLines(diffText);
  const suppressions = findSuppressions(addedLines, { isFenced });
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
    railSources,
    railGlobError,
    violations,
    railsDiffEmpty,
    suppressionsClean,
    sanctionedAdditions: sanctionedAdditionsOut,
  };
}
