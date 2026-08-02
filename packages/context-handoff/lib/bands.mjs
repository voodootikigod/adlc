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
  HANDOFF_COOLDOWN_TOOLS,
} from './thresholds.mjs';

/**
 * Classify a band signal value.
 * - absent (undefined/null): ignore (missing kind)
 * - present but non-finite / non-number (incl. numeric strings, NaN, ±Infinity): hard (fail closed)
 * - finite number: compare against thresholds
 *
 * @param {unknown} value
 * @returns {'absent'|'invalid'|'number'}
 */
export function classifyBandSignal(value) {
  if (value === undefined || value === null) return 'absent';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'invalid';
  return 'number';
}

/**
 * Absolute OR-join across available signals. Missing kinds are ignored.
 * Present-but-malformed signals fail closed as hard.
 * Floor is NEVER subtracted from band comparators (no floor-delta bands).
 * Extra keys such as `floor` on the observed object are ignored.
 *
 * @param {object} observed
 * @param {number} [observed.pct]
 * @param {number} [observed.depth]
 * @param {number} [observed.bytes]
 */
export function evaluateBands(observed = {}) {
  const past = (value, warnAt, handoffAt, hardAt) => {
    const kind = classifyBandSignal(value);
    if (kind === 'absent') {
      return { warn: false, handoff: false, hard: false };
    }
    if (kind === 'invalid') {
      // Present but malformed → fail closed (past every band).
      return { warn: true, handoff: true, hard: true };
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

  return {
    warn: pct.warn || depth.warn || bytes.warn,
    handoff: pct.handoff || depth.handoff || bytes.handoff,
    hard: pct.hard || depth.hard || bytes.hard,
  };
}

/**
 * Absolute hard-band predicate for build-gate consumers.
 * @param {object} observed
 * @returns {boolean}
 */
export function isHardDegraded(observed = {}) {
  return evaluateBands(observed).hard === true;
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
 * @param {number} [opts.cooldownTools=HANDOFF_COOLDOWN_TOOLS]
 * @returns {{ suppressNags: boolean, reason: string }}
 */
export function nagSuppression({
  floor = {},
  minRemaining = MIN_REMAINING_TO_HARD,
  toolsSinceResume = 0,
  cooldownTools = HANDOFF_COOLDOWN_TOOLS,
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
