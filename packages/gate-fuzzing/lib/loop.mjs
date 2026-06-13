// gate-fuzzing/lib/loop.mjs
// Deterministic loop (§3): rounds, dry-streak, inconclusiveRounds tracking (Fix 4).
// fan-failure rate tracking, budget estimation.
// All control flow is code; no model decides when to stop (D0).

import { extractJson } from '@adlc/core';
import { parseCandidates, normalizeAndHash } from './candidate.mjs';

/**
 * Estimate tokens used from fan results (§3.2 option A).
 * labeled as estimate: ≈chars/4.
 * @param {Array<{ok:boolean, value?:string}>} fanResults
 * @param {string} promptText - The prompt sent (for input estimate)
 * @returns {number}
 */
function estimateTokens(fanResults, promptText = '') {
  let chars = promptText.length;
  for (const r of fanResults) {
    if (r.ok && r.value) chars += r.value.length;
    if (!r.ok && r.error) chars += r.error.length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Run the main fuzzing loop.
 *
 * @param {object[]} suite - Gate descriptors
 * @param {object} baseline - {dir: string}
 * @param {object} opts
 * @param {Function} opts.fanFn - async (fanOpts, n) => [{ok, value|error}]
 * @param {Function} opts.classifyFn - (candidate, suite, baseline, classifyOpts) => verdict
 * @param {number} [opts.maxRounds] - default 10
 * @param {number} [opts.dryRounds] - K dry rounds to stop, default 3
 * @param {number} [opts.tokenBudget] - estimated token ceiling, default 200000
 * @param {number} [opts.maxFailRate] - fan failure threshold, default 0.5
 * @param {string} [opts.cloneDir] - fixed clone dir (fallback when no provisionFn)
 * @param {Function} [opts.provisionFn] - (candidate) => {cloneDir, runGateFn, runWitnessFn, oracleFn, destroy}
 *        SECURITY-CRITICAL (Fix 2): when provided, the loop provisions a fresh
 *        disposable clone PER CANDIDATE and classifies inside it under the sandbox,
 *        then always destroys it. The CLI ALWAYS provides this. Tests that stub
 *        classifyFn may omit it and pass a fixed cloneDir instead.
 * @param {number} [opts.n] - fan width, default 6
 * @param {object} [opts.classifyOpts] - extra opts for classifyFn
 * @param {Set<string>} [opts.allowedCmds] - for candidate validation
 * @returns {Promise<{defeats:object[], stoppedBy:string, rounds:number, inconclusiveRounds:number, tokensEstimated:number}>}
 */
export async function runLoop(suite, baseline, opts) {
  const {
    fanFn,
    classifyFn,
    maxRounds = 10,
    dryRounds = 3,
    tokenBudget = 200_000,
    maxFailRate = 0.5,
    cloneDir,
    provisionFn = null,
    n = 6,
    classifyOpts = {},
    allowedCmds,
  } = opts;

  const defeats = [];
  const seenHashes = new Set();
  let round = 0;
  let dryStreak = 0;
  let inconclusiveRounds = 0;
  let tokensEstimated = 0;
  let stoppedBy = 'maxRounds';

  while (round < maxRounds && dryStreak < dryRounds) {
    // Check budget before starting round
    if (tokensEstimated >= tokenBudget) {
      stoppedBy = 'budget';
      break;
    }

    round++;

    // Fan the adversary
    const fanResults = await fanFn({ tier: 'mid' }, n);

    // Estimate tokens this round
    const roundTokens = estimateTokens(fanResults);
    tokensEstimated += roundTokens;

    // After charging tokens, check if we exceeded budget
    if (tokensEstimated > tokenBudget) {
      stoppedBy = 'budget';
      break;
    }

    // Fan-failure rate check (F5, Fix 4)
    const failedCount = fanResults.filter((r) => !r.ok).length;
    const failRate = fanResults.length > 0 ? failedCount / fanResults.length : 1;

    if (failRate > maxFailRate) {
      // Round is inconclusive — do NOT advance dryStreak
      inconclusiveRounds++;
      continue;
    }

    // Parse and classify candidates
    let newDefeatsThisRound = 0;

    for (const result of fanResults) {
      if (!result.ok) continue;

      // Parse candidates from model output
      const { candidates } = parseCandidates(result.value, {
        extractJson,
        allowedCmds,
      });

      for (const candidate of candidates) {
        const verdict = await classifyOneCandidate(candidate, {
          classifyFn,
          suite,
          baseline,
          classifyOpts,
          cloneDir,
          provisionFn,
        });

        if (verdict.result === 'DEFEAT') {
          // Dedup check (§3.3)
          const hash = normalizeAndHash({
            target: candidate.target,
            claimKind: candidate.claimKind,
            diff: candidate.diff,
          });

          if (!seenHashes.has(hash)) {
            seenHashes.add(hash);
            defeats.push({ ...candidate, verdict, hash });
            newDefeatsThisRound++;
          }
        }
      }
    }

    // Update dry streak
    if (newDefeatsThisRound > 0) {
      dryStreak = 0; // new defeats reset the streak
    } else {
      dryStreak++;
    }

    if (dryStreak >= dryRounds) {
      stoppedBy = 'dry';
      break;
    }
  }

  // If we exhausted maxRounds without dry-streak or budget stop
  if (round >= maxRounds && stoppedBy === 'maxRounds') {
    stoppedBy = 'maxRounds';
  }

  return {
    defeats,
    stoppedBy,
    rounds: round,
    inconclusiveRounds,
    tokensEstimated,
    exhaustive: stoppedBy === 'dry',
  };
}

/**
 * Classify a single candidate.
 *
 * SECURITY-CRITICAL (Fix 2): when a provisionFn is supplied, the candidate is
 * executed inside a FRESH disposable clone bound to the sandbox, NEVER the real
 * working tree. The clone is ALWAYS destroyed afterward (finally), even if
 * classify throws or a witness/setup times out.
 *
 * When no provisionFn is supplied (unit tests that stub classifyFn), it falls
 * back to the fixed cloneDir path.
 *
 * @param {object} candidate
 * @param {object} ctx
 * @returns {Promise<object>} verdict
 */
async function classifyOneCandidate(candidate, ctx) {
  const { classifyFn, suite, baseline, classifyOpts, cloneDir, provisionFn } = ctx;

  if (!provisionFn) {
    // Fallback: fixed cloneDir, no per-candidate provisioning (stubbed tests only).
    return classifyFn(candidate, suite, baseline, { ...classifyOpts, cloneDir });
  }

  // Provision a fresh disposable clone for THIS candidate.
  const provisioned = await provisionFn(candidate);
  try {
    if (provisioned.error) {
      // Provisioning failed (e.g. diff did not apply) → inconclusive, never a defeat.
      return {
        result: 'inconclusive',
        target: candidate.target,
        reason: `provision failed: ${provisioned.error}`,
      };
    }
    return classifyFn(candidate, suite, baseline, {
      ...classifyOpts,
      cloneDir: provisioned.cloneDir,
      runGateFn: provisioned.runGateFn,
      runWitnessFn: provisioned.runWitnessFn,
      oracleFn: provisioned.oracleFn,
    });
  } finally {
    // ALWAYS destroy the clone, even on throw/timeout.
    if (typeof provisioned.destroy === 'function') provisioned.destroy();
  }
}
