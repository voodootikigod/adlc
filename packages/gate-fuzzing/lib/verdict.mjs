// gate-fuzzing/lib/verdict.mjs
// §3.1 verdict computation with inconclusiveRounds threading (Fix 4).
// Fix 5: behavioral-only defeats default to REPORT (exit 0), not exit 2.
//        --fail-on-behavioral opts into exit 2 for behavioral defeats.

/**
 * Determine if a defeat is contract-derived (exit-2 by default) or behavioral-only.
 * Contract-derived: witnessSource === 'contract-derived'
 * Behavioral: witnessSource === 'independently-approved'
 *
 * @param {object} defeat
 * @returns {'contract'|'behavioral'}
 */
function classifyDefeatSource(defeat) {
  if (defeat.witnessSource === 'contract-derived') return 'contract';
  return 'behavioral';
}

/**
 * Determine if a run's stop reason is "inconclusive" (not an earned clean stop).
 * An earned clean stop requires: stopped-by dry-streak.
 * Everything else (budget, maxRounds) is inconclusive if no defeats found.
 *
 * Fix 4: A round exceeding --max-fail-rate is inconclusive and must NOT advance
 * dryStreak. If run never produced a clean dry-streak AND inconclusiveRounds
 * dominated, verdict() returns inconclusive.
 *
 * @param {{stoppedBy:string, inconclusiveRounds:number, rounds:number}} runState
 * @returns {boolean}
 */
function isRunInconclusive(runState) {
  const { stoppedBy, inconclusiveRounds, rounds } = runState;

  // If stopped by dry-streak, run was successful (not inconclusive)
  if (stoppedBy === 'dry') return false;

  // If all rounds were inconclusive → definitely inconclusive
  if (rounds > 0 && inconclusiveRounds === rounds) return true;

  // If stopped by budget or maxRounds (not dry) → inconclusive
  if (stoppedBy === 'budget' || stoppedBy === 'maxRounds' || stoppedBy === 'inconclusive') return true;

  return false;
}

/**
 * Compute the final verdict for a gate-fuzzing run.
 *
 * @param {object} opts
 * @param {object[]} opts.defeats - All confirmed defeats
 * @param {string} opts.stoppedBy - 'dry'|'budget'|'maxRounds'|'inconclusive'
 * @param {number} opts.inconclusiveRounds - Count of inconclusive rounds (Fix 4)
 * @param {number} opts.rounds - Total rounds run
 * @param {boolean} opts.strictBudget - --strict-budget flag
 * @param {boolean} opts.failOnBehavioral - --fail-on-behavioral flag (Fix 5)
 * @returns {{exitCode:0|1|2, summary:string, defeats:object[], contractDefeats:number, behavioralDefeats:number, inconclusive:boolean}}
 */
export function computeVerdict(opts) {
  const {
    defeats,
    stoppedBy,
    inconclusiveRounds,
    rounds,
    strictBudget,
    failOnBehavioral,
  } = opts;

  // Categorize defeats by source
  const contractDefeats = defeats.filter((d) => classifyDefeatSource(d) === 'contract');
  const behavioralDefeats = defeats.filter((d) => classifyDefeatSource(d) === 'behavioral');

  // Check if run was inconclusive
  const inconclusive = isRunInconclusive({ stoppedBy, inconclusiveRounds, rounds });

  // Contract defeats always drive exit 2 (Fix 5: only contract-derived defeats
  // drive exit 2 by default)
  if (contractDefeats.length > 0) {
    return {
      exitCode: 2,
      summary: 'gate-defeated',
      defeats,
      contractDefeats: contractDefeats.length,
      behavioralDefeats: behavioralDefeats.length,
      inconclusive: false,
    };
  }

  // Behavioral defeats: exit 2 only with --fail-on-behavioral (Fix 5)
  if (behavioralDefeats.length > 0) {
    if (failOnBehavioral) {
      return {
        exitCode: 2,
        summary: 'gate-defeated',
        defeats,
        contractDefeats: 0,
        behavioralDefeats: behavioralDefeats.length,
        inconclusive: false,
      };
    }
    // Default: REPORT (exit 0 with defeats listed)
    return {
      exitCode: 0,
      summary: 'behavioral-defeats-reported',
      defeats,
      contractDefeats: 0,
      behavioralDefeats: behavioralDefeats.length,
      inconclusive: false,
    };
  }

  // No defeats — check if run was inconclusive
  if (inconclusive) {
    return {
      exitCode: strictBudget ? 1 : 0,
      summary: 'inconclusive',
      defeats: [],
      contractDefeats: 0,
      behavioralDefeats: 0,
      inconclusive: true,
    };
  }

  // Clean stop: dry streak with no defeats
  return {
    exitCode: 0,
    summary: 'clean',
    defeats: [],
    contractDefeats: 0,
    behavioralDefeats: 0,
    inconclusive: false,
  };
}
