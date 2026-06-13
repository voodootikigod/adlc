/**
 * Core merge-forecast logic: orchestrates signals, width calculations,
 * and schedule construction.
 */

import { parallelEligiblePairs, topoWaves, mergeOrder } from './reachability.mjs';
import { pairScore } from './signals.mjs';
import { walkTree } from './signals.mjs';
import { isGitRepo, coChange, topoSort } from '@adlc/core';

/**
 * Run the full forecast.
 *
 * @param {object} opts
 * @param {Array}  opts.tickets           — loaded ticket objects
 * @param {string} opts.root              — repo root (for file walking + git)
 * @param {number} opts.coChangeLimit     — git log limit (default 500)
 * @param {number} opts.conflictThreshold — score >= this is a "conflict risk" (default 0.5)
 * @param {number|null} opts.width        — --width flag value (null if not given)
 * @param {number|null} opts.buildMin     — --build-min (null if not given)
 * @param {number|null} opts.mergeMin     — --merge-min (null if not given)
 * @returns {object} forecast result
 */
export async function runForecast(opts) {
  const {
    tickets,
    root,
    coChangeLimit = 500,
    conflictThreshold = 0.5,
    width = null,
    buildMin = null,
    mergeMin = null,
  } = opts;

  // Validate the ticket DAG (Spec D2): a dependency cycle makes the schedule
  // undefined. topoWaves drains indegree-0 nodes and silently DROPS any node
  // trapped in a cycle, producing an empty/partial schedule with a clean exit.
  // Detect that here and fail the gate instead, naming the offending tickets.
  const { cycle } = topoSort(tickets);
  if (cycle && cycle.length > 0) {
    return {
      pairs: [],
      waves: [],
      mergeOrder: [],
      certifiedWidth: 0,
      backpressureWidth: null,
      recommendedWidth: 0,
      warnings: [],
      gateFailures: [
        `dependency cycle in ticket DAG — cannot schedule: ` +
          cycle.join(', '),
      ],
      pullQueueNote: 'idle builders claim next unblocked',
    };
  }

  // Walk the repo tree once
  const repoFiles = walkTree(root);

  // Co-change data — degrade gracefully if not a git repo or shallow
  let coChangeData = null;
  const warnings = [];
  if (isGitRepo(root)) {
    try {
      coChangeData = coChange(coChangeLimit, root);
    } catch (err) {
      const msg = err.message ?? String(err);
      if (msg.includes('shallow') || msg.includes('no commits')) {
        warnings.push('co-change skipped: shallow clone or no history');
      } else {
        warnings.push(`co-change skipped: ${msg}`);
      }
    }
  } else {
    warnings.push('co-change skipped: not a git repo');
  }

  // Compute parallel-eligible pairs
  const pairs = parallelEligiblePairs(tickets);

  // Score each pair
  const pairResults = pairs.map(([a, b]) => {
    const { score, signal, hardVeto } = pairScore(a, b, {
      repoFiles,
      root,
      coChangeData,
    });
    const verdict = hardVeto
      ? 'VETO'
      : score >= conflictThreshold
      ? 'SEQUENCE'
      : 'PARALLEL';
    return {
      pair: `${a.id}–${b.id}`,
      a: a.id,
      b: b.id,
      score: Math.round(score * 1000) / 1000,
      signal,
      verdict,
      hardVeto,
    };
  });

  // Build topological waves
  const waves = topoWaves(tickets);
  const order = mergeOrder(tickets);

  // CertifiedWidth: greedy largest set of pairwise-below-threshold tickets in wave 1
  const wave1 = waves[0] ?? [];
  const certifiedWidth = computeCertifiedWidth(wave1, pairResults, conflictThreshold);

  // BackpressureWidth
  const backpressureWidth =
    buildMin !== null && mergeMin !== null && mergeMin > 0
      ? Math.round(buildMin / mergeMin)
      : null;

  // RecommendedWidth
  const candidates = [certifiedWidth];
  if (backpressureWidth !== null) candidates.push(backpressureWidth);
  if (width !== null) candidates.push(width);
  const recommendedWidth = Math.min(...candidates);

  // Gate failures
  const gateFailures = [];

  // Fail if --width exceeds certifiedWidth
  if (width !== null && width > certifiedWidth) {
    gateFailures.push(
      `--width ${width} exceeds certifiedWidth ${certifiedWidth}`
    );
  }

  // Fail if any vetoed pair would be scheduled concurrently (both in same wave)
  const waveMap = new Map();
  for (let w = 0; w < waves.length; w++) {
    for (const id of waves[w]) waveMap.set(id, w);
  }
  const concurrentVetoes = pairResults.filter((pr) => {
    if (!pr.hardVeto) return false;
    // Vetoed pair — check if both in same wave
    const wA = waveMap.get(pr.a);
    const wB = waveMap.get(pr.b);
    return wA !== undefined && wB !== undefined && wA === wB;
  });
  if (concurrentVetoes.length > 0) {
    gateFailures.push(
      `${concurrentVetoes.length} high-risk pair(s) would run concurrently: ` +
        concurrentVetoes.map((p) => p.pair).join(', ')
    );
  }

  return {
    pairs: pairResults,
    waves,
    mergeOrder: order,
    certifiedWidth,
    backpressureWidth,
    recommendedWidth,
    warnings,
    gateFailures,
    pullQueueNote: 'idle builders claim next unblocked',
  };
}

/**
 * Greedy largest set of pairwise-below-threshold tickets from a wave.
 * Build the conflict graph among wave1 tickets, then find a greedy independent set.
 */
function computeCertifiedWidth(wave1Ids, pairResults, threshold) {
  if (wave1Ids.length === 0) return 0;

  // Build conflict adjacency set among wave1 tickets
  const conflicted = new Set();
  for (const pr of pairResults) {
    if (pr.score >= threshold || pr.hardVeto) {
      if (wave1Ids.includes(pr.a) && wave1Ids.includes(pr.b)) {
        conflicted.add(`${pr.a}|${pr.b}`);
        conflicted.add(`${pr.b}|${pr.a}`);
      }
    }
  }

  function hasConflict(id, chosen) {
    return chosen.some((c) => conflicted.has(`${id}|${c}`));
  }

  // Greedy: try each ticket as a starting point and build the largest set
  let best = 0;
  for (let start = 0; start < wave1Ids.length; start++) {
    const chosen = [];
    // Start from `start` index to vary greedy seed
    const order = [
      ...wave1Ids.slice(start),
      ...wave1Ids.slice(0, start),
    ];
    for (const id of order) {
      if (!hasConflict(id, chosen)) chosen.push(id);
    }
    if (chosen.length > best) best = chosen.length;
  }
  return best;
}
