// Shared absolute band thresholds. Adapters MUST import these (no local copies).
// Inclusive band edges (>=) are intentional in evaluateBands; see bands.mjs.

export const WARN_PCT = 50;
export const HANDOFF_PCT = 60;
export const HARD_PCT = 80;

export const WARN_DEPTH = 20;
export const HANDOFF_DEPTH = 30;
export const HARD_DEPTH = 40;

export const WARN_BYTES = 128 * 1024;
export const HANDOFF_BYTES = 192 * 1024;
export const HARD_BYTES = 256 * 1024;

export const HANDOFF_COOLDOWN_TOOLS = 15;
/**
 * Suppress advisory nags when remaining-to-hard is BELOW this fraction
 * (near-hard / handoff zone — deny/handoff owns the signal). Never mutation deny.
 */
export const MIN_REMAINING_TO_HARD = 0.25;
export const HANDOFF_MAX_AGE_HOURS = 72;

/** @returns {boolean} */
export function thresholdsOrdered() {
  return (
    WARN_PCT < HANDOFF_PCT &&
    HANDOFF_PCT < HARD_PCT &&
    WARN_DEPTH < HANDOFF_DEPTH &&
    HANDOFF_DEPTH < HARD_DEPTH &&
    WARN_BYTES < HANDOFF_BYTES &&
    HANDOFF_BYTES < HARD_BYTES
  );
}
