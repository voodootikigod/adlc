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
  // Non-object / array / null container: fail closed (same as per-field invalid).
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) {
    return { warn: true, handoff: true, hard: true };
  }
  const past = (value, warnAt, handoffAt, hardAt, inDomain) => {
    const kind = classifyBandSignal(value);
    if (kind === 'absent') {
      return { warn: false, handoff: false, hard: false };
    }
    if (kind === 'invalid' || !inDomain(value)) {
      // Present but malformed / out-of-domain → fail closed (past every band).
      return { warn: true, handoff: true, hard: true };
    }
    // Inclusive (>=): at-threshold is in-band. build-gate today uses strict >
    // for depth/bytes; slice-3 migration must adopt inclusive or document a flip.
    return {
      warn: value >= warnAt,
      handoff: value >= handoffAt,
      hard: value >= hardAt,
    };
  };

  const pct = past(observed.pct, WARN_PCT, HANDOFF_PCT, HARD_PCT, (v) => v >= 0 && v <= 100);
  const depth = past(observed.depth, WARN_DEPTH, HANDOFF_DEPTH, HARD_DEPTH, (v) => v >= 0);
  const bytes = past(observed.bytes, WARN_BYTES, HANDOFF_BYTES, HARD_BYTES, (v) => v >= 0);

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
 * Remaining-to-hard fraction for advisory nag suppression only (never deny).
 * Fraction of HARD_* headroom still left from the floor snapshot.
 * @param {object} floor
 * @returns {number|null} min fraction across available signals, or null if none
 */
export function remainingToHard(floor = {}) {
  if (floor === null || typeof floor !== 'object' || Array.isArray(floor)) {
    return 0; // fail closed: no headroom → suppress nags path sees depleted
  }
  const fracs = [];
  for (const [key, hard] of [
    ['pct', HARD_PCT],
    ['depth', HARD_DEPTH],
    ['bytes', HARD_BYTES],
  ]) {
    const value = floor[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0; // present-but-malformed floor → treat as depleted
    }
    // Match evaluateBands domain: out-of-domain finite → depleted (no headroom).
    const inDomain =
      key === 'pct' ? value >= 0 && value <= 100 : value >= 0;
    if (!inDomain) {
      return 0;
    }
    fracs.push((hard - value) / hard);
  }
  if (fracs.length === 0) return null;
  return Math.min(...fracs);
}

/**
 * Headroom/cooldown suppress **advisory nags** only — never deny.
 *
 * Suppress advisories when remaining-to-hard is BELOW `minRemaining`
 * (near-hard / handoff territory): absolute deny/handoff already owns the
 * signal, so nags are for earlier advisory pressure only. This path never
 * affects mutation deny (`handoffDenyActive` ignores nags).
 *
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
    return {
      suppressNags: true,
      reason: 'near-hard headroom: advisory nags deferred to deny',
    };
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
