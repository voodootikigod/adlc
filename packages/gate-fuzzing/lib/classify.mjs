// gate-fuzzing/lib/classify.mjs
// §1.8 truth table: candidate → verdict.
// Surface + claim binding + gate execution + witness discrimination + oracle independence.
// Fix 5: witnessSource field on all DEFEAT verdicts.

import { globMatch } from '../../core/index.mjs';
import { discriminateWitness } from './witness.mjs';
import { checkOracle } from './oracle.mjs';

/**
 * Extract changed file paths from a unified diff string.
 * @param {string} diff
 * @returns {string[]}
 */
function changedFilesFromDiff(diff) {
  const paths = new Set();
  for (const line of diff.split('\n')) {
    // "diff --git a/foo b/foo" → foo
    const m = line.match(/^diff --git a\/(.+) b\//);
    if (m) paths.add(m[1]);
    // +++ b/foo
    const m2 = line.match(/^\+\+\+ b\/(.+)/);
    if (m2 && m2[1] !== '/dev/null') paths.add(m2[1]);
  }
  return [...paths];
}

/**
 * Check if any changed file intersects the gate's declared surface globs.
 * @param {string[]} changedFiles
 * @param {string[]} surface - glob patterns
 * @returns {boolean}
 */
function intersectsSurface(changedFiles, surface) {
  if (!surface || surface.length === 0) return false;
  if (surface.includes('**')) return true;
  for (const file of changedFiles) {
    for (const pattern of surface) {
      if (globMatch(pattern, file)) return true;
    }
  }
  return false;
}

/**
 * Classify a candidate against the gate suite (§1.8 truth table).
 *
 * @param {object} candidate - Validated candidate (§1.2 shape)
 * @param {object[]} suite - Gate descriptors
 * @param {object} baseline - {dir: string}
 * @param {object} opts
 * @param {Function} opts.runGateFn - (gateName, cloneDir, setupCmds) => {exitCode}
 * @param {Function} opts.runWitnessFn - (spec, dir) => {status, timedOut}
 * @param {Function} opts.oracleFn - (candidate) => {independent, source, reason?}
 * @param {number} [opts.witnessTrials] - Default 3
 * @param {string} opts.cloneDir
 * @returns {object} verdict with .result field
 */
export function classifyCandidate(candidate, suite, baseline, opts) {
  const {
    runGateFn,
    runWitnessFn,
    oracleFn,
    witnessTrials = 3,
    cloneDir,
  } = opts;

  // Find the target gate descriptor
  const targetGate = suite.find((g) => g.name === candidate.target);
  if (!targetGate) {
    return { result: 'invalid:target', reason: `unknown gate: ${candidate.target}` };
  }

  // Clause 3: surface intersection check
  const changedFiles = changedFilesFromDiff(candidate.diff);
  if (!intersectsSurface(changedFiles, targetGate.surface)) {
    return {
      result: 'out-of-scope',
      target: candidate.target,
      reason: `diff does not intersect gate surface: [${(targetGate.surface ?? []).join(', ')}]`,
    };
  }

  // Clause 4: claim kind check
  if (!targetGate.claims?.includes(candidate.claimKind)) {
    return {
      result: 'wrong-claim',
      target: candidate.target,
      reason: `claimKind ${candidate.claimKind} not in gate claims: [${(targetGate.claims ?? []).join(', ')}]`,
    };
  }

  // Run setup commands (if any) — these are pre-gate mutations to the clone
  // (In tests, runGateFn handles setup implicitly via the gate name)

  // Clause 2: run ALL gates against the post-setup candidate tree
  for (const gate of suite) {
    const r = runGateFn(gate.name, cloneDir, candidate.setup ?? []);
    if (r.exitCode === 2) {
      return {
        result: 'caught',
        target: candidate.target,
        caughtBy: gate.name,
        reason: `caught by gate: ${gate.name}`,
      };
    }
    if (r.exitCode === 1) {
      return {
        result: 'inconclusive',
        target: candidate.target,
        reason: `gate ${gate.name} exited 1 (inconclusive)`,
      };
    }
  }

  // Clause 5: witness discrimination (N-trial unanimous, §1.4)
  const witnessSpec = candidate.witnessProposal;
  const discrimination = discriminateWitness(
    witnessSpec,
    { baselineDir: baseline.dir, candidateDir: cloneDir },
    { trials: witnessTrials, runFn: runWitnessFn }
  );

  if (!discrimination.discriminates) {
    // Could be inconclusive (flaky) or failed to discriminate
    if (discrimination.reason === 'inconclusive' || discrimination.reason.startsWith('inconclusive:')) {
      return {
        result: 'inconclusive',
        target: candidate.target,
        reason: `witness ${discrimination.reason}`,
      };
    }
    return {
      result: 'unwitnessed',
      target: candidate.target,
      reason: `witness did not discriminate: ${discrimination.reason}`,
    };
  }

  // Check oracle independence (§1.1)
  const oracle = oracleFn(candidate);
  if (!oracle.independent) {
    return {
      result: 'unwitnessed',
      target: candidate.target,
      reason: oracle.reason ?? 'witness not independently verified',
    };
  }

  // All clauses passed → DEFEAT
  return {
    result: 'DEFEAT',
    target: candidate.target,
    claimKind: candidate.claimKind,
    strategy: candidate.strategy,
    witnessSource: oracle.source,
    reason: 'all defeat conditions satisfied',
  };
}
