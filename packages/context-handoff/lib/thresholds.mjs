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

/**
 * Phase 0 hotfix (context-rot-threshold-calibration spec §1.2.2): the transcript
 * scan's only two budgets. The prior MAX_SCAN_BYTES constant equaled HARD_BYTES
 * (256 KiB) and its overrun set depth to +Infinity — a routine fresh-session
 * baseline with several plugins/skills loaded already exceeds 256 KiB, so this
 * was the actual production lockout, not an edge case. MAX_SCAN_BYTES is
 * retired entirely (no adapter may re-declare a local constant under either
 * name); these two budgets replace it. A scan that exceeds either before
 * reaching start-of-file reports the depth accumulated so far — a finite lower
 * bound, never +Infinity.
 */
export const MAX_ACTIVE_CONTEXT_BYTES = 8 * 1024 * 1024;
/**
 * Wall-clock ceiling for a transcript scan. Sequential reads of a few MB
 * complete in low tens of milliseconds on ordinary storage; this budget is
 * generous headroom above that for slower disks/filesystems, not a target.
 */
export const MAX_SCAN_WALL_MS = 500;

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
