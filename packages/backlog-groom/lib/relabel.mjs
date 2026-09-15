/**
 * Relabel proposals (spec §3.4a).
 *
 * Exactly two triggers, and nothing else produces a `relabel`:
 *  - PRIORITY — the computed rank disagrees with the existing priority label.
 *    A judgment, so the proposal carries reasoning.
 *  - AREA — the issue's VERIFIED locations sit in a different profile unit than
 *    its `area:` label claims. Mechanically provable, so the proposal carries
 *    the paths rather than an argument.
 *
 * THE EXCLUSION THE SPEC NAMES: an issue whose locations could not be verified
 * never produces an area relabel. An unverified location is not evidence that
 * the code moved — it is only evidence of what the issue's author typed.
 *
 * This module PROPOSES. Whether a proposal executes is the write path's
 * decision, through the gate (§3.6) and the autonomy floor (§3.7).
 */

import { unitsForIssue } from './cluster.mjs';

/** Verdicts whose locations are established well enough to argue a move. */
const LOCATION_VERIFIED = new Set(['valid', 'fixed']);

/**
 * @param {object[]} rows - `{number, labels, verified, classified, rank}`
 * @param {object} profile - a parsed profile
 * @returns {object[]} relabel proposals
 */
export function relabelProposals(rows, profile) {
  const priorityMap = profile?.labels?.priority ?? {};
  const areaPrefix = profile?.labels?.areaPrefix ?? 'area:';
  const units = profile?.units ?? [];
  const out = [];

  for (const row of rows ?? []) {
    const labels = row.labels ?? [];
    const verdict = row.verified?.verdict;

    // ---- priority ---------------------------------------------------------
    // Only a DISAGREEMENT proposes. An unlabelled issue is not disagreeing with
    // anything, and proposing a label for every one of them would bury the real
    // disagreements. A `fixed` issue is heading for a close proposal, so
    // re-prioritising it on the way out is noise.
    const currentPriority = Object.entries(priorityMap).find(([, label]) => labels.includes(label));
    if (currentPriority && verdict !== 'fixed' && row.rank?.band && row.rank.band !== currentPriority[0]) {
      const to = priorityMap[row.rank.band];
      if (to) {
        out.push({
          number: row.number,
          action: 'relabel',
          field: 'priority',
          from: currentPriority[1],
          to,
          evidence:
            `computed rank ${row.rank.band} (score ${row.rank.score}) disagrees with the ${currentPriority[1]} label; ` +
            `rank inputs: ${JSON.stringify(row.rank.inputs ?? {})}`,
        });
      }
    }

    // ---- area -------------------------------------------------------------
    const currentArea = labels.find((l) => l.startsWith(areaPrefix));
    if (!currentArea) continue;
    if (!LOCATION_VERIFIED.has(verdict)) continue;

    const inUnits = unitsForIssue(row.verified, row.classified, units);
    // Nothing to prove unless the locations land in exactly ONE unit: a path in
    // no declared unit says nothing, and paths spanning two units mean the issue
    // is still partly where the label says.
    if (inUnits.length !== 1) continue;

    const actual = `${areaPrefix}${inUnits[0]}`;
    if (actual === currentArea) continue;

    const paths = [...new Set((row.classified?.references ?? []).map((r) => r.path))];
    out.push({
      number: row.number,
      action: 'relabel',
      field: 'area',
      from: currentArea,
      to: actual,
      evidence: `verified locations sit in unit ${inUnits[0]}: ${paths.join(', ')}`,
    });
  }
  return out;
}
