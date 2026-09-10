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

/**
 * The recall an echoing reviewer may reach before the judge that scored it is
 * considered unbounded. An echoer describes nothing, so a judge worth trusting
 * gives it 0; anything above this is a judge with a non-semantic shortcut, a
 * permissive judge, or one that has been steered. Inclusive.
 *
 * This is the ONLY place the bound is spelled — issue #753 arose precisely
 * because the check existed in one place and the judge it was meant to bound
 * lived in another.
 */
export const ECHO_BOUND = 0.001;

/**
 * Run the negative control through a SPECIFIC judge and report whether that
 * judge is bounded by it.
 *
 * The caller decides which judge: the deterministic `referenceJudge` bounds the
 * scorer's aggregation, while the judge configured for the run bounds the
 * instrument that actually produces the reported recall. Before #753 only the
 * former was ever checked, so a permissive, injected or garbage LLM judge — and
 * `--scorer string`'s literal `() => true` — passed a "control self-test" that
 * had never been near it.
 *
 * `scorePlants` is injected rather than imported so the whole check is
 * unit-testable with fake judges and no network.
 *
 * @param {object} deps
 * @param {Array<object>} deps.plants
 * @param {(plant, finding) => (boolean|Promise<boolean>)} deps.judge
 * @param {(plants, findings, deps) => Promise<{recall:number}>} deps.scorePlants
 * @returns {Promise<{echoRecall:number, bounded:boolean}>}
 */
export async function echoControl({ plants, judge, scorePlants }) {
  const { recall } = await scorePlants(plants, echoReviewer(plants), { judge });
  return { echoRecall: recall, bounded: recall <= ECHO_BOUND };
}

/**
 * Render a control recall for an operator-facing message. Three decimals is
 * one more than the bound's leading zeros, so a number that failed the check
 * always prints as visibly non-zero rather than rounding to "0.00".
 *
 * @param {number} recall
 * @returns {string}
 */
export function formatRecall(recall) {
  return recall.toFixed(3);
}

/**
 * Decide whether the configured judge's echo-control result should stop the
 * run, and with what message.
 *
 * Pure, and separate from the CLI, because the branch that matters most is the
 * one an offline test can never reach through the bin: refusing to certify a
 * recall figure measured with an LLM judge that cannot reject an echoing
 * reviewer. Keeping the decision here means that refusal — and its wording —
 * is verified rather than merely written.
 *
 * @param {object} args
 * @param {string} args.scorerMode              'judge' | 'string'
 * @param {boolean|null} args.bounded           control verdict; null = judge rendered no verdict
 * @param {number|null} args.echoRecall
 * @param {string|undefined} args.judgeProviderName
 * @param {string} args.tier
 * @returns {string|null}  the operator-facing failure message, or null to proceed
 */
export function judgeBoundFailure({ scorerMode, bounded, echoRecall, judgeProviderName, tier }) {
  // `--scorer string` sets the judge to match everything by construction, so it
  // can never satisfy this control. Failing there would delete a documented,
  // deliberately-warned mode; the scorecard reports it uncertified instead.
  if (scorerMode === 'string') return null;
  // null = the judge was never consulted, so it contributed nothing to the
  // figure and there is nothing to bound. Only an actual failure stops the run.
  if (bounded !== false) return null;
  return (
    `judge self-test FAILED: the configured judge (${judgeProviderName ?? 'unknown provider'}, tier ${tier}) ` +
    `scored the echo control ${formatRecall(echoRecall)} (must be ~0) — it cannot distinguish ` +
    'a reviewer that only echoes changed lines from one that identifies defects. Refusing to certify a recall ' +
    'number measured with it.'
  );
}
