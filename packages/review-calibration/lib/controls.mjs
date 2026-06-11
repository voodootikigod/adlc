// review-calibration/lib/controls.mjs
// Reference reviewers with KNOWN-correct scores that pin the scorer at both
// extremes — the "calibrate the calibrator" answer, bounded, no infinite
// regress. A correct scorer gives the echoer ~0 and the oracle 1.0.

import { basename } from 'node:path';

/**
 * Negative control. Emits one content-free finding per plant — it echoes the
 * changed line and claims nothing. A correct scorer MUST score this ~0.
 * This is the reviewer the original string-match scorer wrongly gave recall 1.0.
 *
 * @param {Array<{file:string, line:number, mutated:string}>} plants
 * @returns {Array<{file, line, description, evidence}>}
 */
export function echoReviewer(plants) {
  return plants.map((p) => ({
    file: basename(p.file),
    line: p.line,
    description: `${basename(p.file)}:${p.line} changed`,
    evidence: p.mutated,
  }));
}

/**
 * Positive control. Handed the plant list, emits a perfect finding per plant
 * (correct location + the actual defect description). A correct scorer MUST
 * score this 1.0; less means the scorer has false negatives (too strict).
 *
 * @param {Array<{file:string, line:number, defect:string, mutated:string}>} plants
 * @returns {Array<{file, line, description, evidence}>}
 */
export function oracleReviewer(plants) {
  return plants.map((p) => ({
    file: basename(p.file),
    line: p.line,
    description: p.defect ?? `defect at ${basename(p.file)}:${p.line}`,
    evidence: p.mutated,
  }));
}
