import {
  WARN_PCT,
  HANDOFF_PCT,
  HARD_PCT,
  WARN_DEPTH,
  HANDOFF_DEPTH,
  HARD_DEPTH,
  WARN_BYTES,
  HANDOFF_BYTES,
  HARD_BYTES,
  MIN_REMAINING_TO_HARD,
} from './thresholds.mjs';

/**
 * Absolute OR-join across available signals. Missing kinds are ignored.
 * Floor is NEVER subtracted from band comparators (no floor-delta bands).
 *
 * @param {object} observed
 * @param {number} [observed.pct]
 * @param {number} [observed.depth]
 * @param {number} [observed.bytes]
 * @param {boolean} [observed.compacted]
 */
export function evaluateBands(observed = {}) {
  const past = (value, warnAt, handoffAt, hardAt) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { warn: false, handoff: false, hard: false };
    }
    return {
      warn: value >= warnAt,
      handoff: value >= handoffAt,
      hard: value >= hardAt,
    };
  };

  const pct = past(observed.pct, WARN_PCT, HANDOFF_PCT, HARD_PCT);
  const depth = past(observed.depth, WARN_DEPTH, HANDOFF_DEPTH, HARD_DEPTH);
  const bytes = past(observed.bytes, WARN_BYTES, HANDOFF_BYTES, HARD_BYTES);
  const compactedHard = observed.compacted === true;

  return {
    warn: pct.warn || depth.warn || bytes.warn,
    handoff: pct.handoff || depth.handoff || bytes.handoff,
    hard: pct.hard || depth.hard || bytes.hard || compactedHard,
  };
}

/**
 * Remaining-to-hard fraction for nag suppression only.
 * @param {object} floor
 * @returns {number|null} min fraction across available signals, or null if none
 */
export function remainingToHard(floor = {}) {
  const fracs = [];
  if (typeof floor.pct === 'number') fracs.push((HARD_PCT - floor.pct) / HARD_PCT);
  if (typeof floor.depth === 'number') fracs.push((HARD_DEPTH - floor.depth) / HARD_DEPTH);
  if (typeof floor.bytes === 'number') fracs.push((HARD_BYTES - floor.bytes) / HARD_BYTES);
  if (fracs.length === 0) return null;
  return Math.min(...fracs);
}

/**
 * Headroom/cooldown suppress **advisory nags** only — never deny.
 * @param {object} opts
 * @param {object} [opts.floor]
 * @param {number} [opts.minRemaining=MIN_REMAINING_TO_HARD]
 * @param {number} [opts.toolsSinceResume=0]
 * @param {number} [opts.cooldownTools]
 * @returns {{ suppressNags: boolean, reason: string }}
 */
export function nagSuppression({
  floor = {},
  minRemaining = MIN_REMAINING_TO_HARD,
  toolsSinceResume = 0,
  cooldownTools = 15,
} = {}) {
  const rem = remainingToHard(floor);
  if (rem !== null && rem < minRemaining) {
    return { suppressNags: true, reason: 'remaining-to-hard below minimum' };
  }
  if (toolsSinceResume < cooldownTools) {
    return { suppressNags: true, reason: 'post-resume cooldown' };
  }
  return { suppressNags: false, reason: 'nags allowed' };
}

/**
 * Deny activation follows absolute handoff — independent of nag suppression.
 * @param {ReturnType<typeof evaluateBands>} bands
 * @param {ReturnType<typeof nagSuppression>} nags
 */
export function handoffDenyActive(bands, nags) {
  void nags; // nags must not affect deny
  return bands.handoff === true || bands.hard === true;
}
