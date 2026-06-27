// gate-bins.mjs — the ADLC command surface OpenCode maps to.
//
// First use of any gate must not fail with ENOENT, so the integration declares
// the full set up front (integration-plan §7 Phase A). The dispatcher routes
// `adlc <tool>`; the runner handles phase-evidence assertions.

/** The umbrella dispatcher and the phase-evidence runner (ADR 0002, Option D). */
export const DISPATCHERS = ['adlc', 'adlc-runner'];

/** The 19 gate tools dispatched via `adlc <tool>` (integration-plan §7 Phase A). */
export const GATE_BINS = [
  'behavior-diff',
  'coldstart',
  'consensus-fix',
  'flail-detector',
  'gate-fuzzing',
  'gate-manifest',
  'hollow-test',
  'lesson-foundry',
  'merge-forecast',
  'model-ratchet',
  'model-router',
  'parallax',
  'preflight',
  'premortem',
  'rails-guard',
  'rejection-mining',
  'review-calibration',
  'skill-rot',
  'spec-lint',
];

/** Everything the integration expects to be resolvable. */
export const ALL_BINS = [...DISPATCHERS, ...GATE_BINS];
