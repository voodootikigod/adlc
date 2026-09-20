/**
 * Core merge-forecast logic: orchestrates signals, width calculations,
 * and schedule construction.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      firstWaveWidth: 0,
      scheduleWidth: 0,
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
      if (Object.keys(coChangeData.fileCounts).length === 0) {
        warnings.push('co-change: zero commits or empty file history');
      } else if (Object.keys(coChangeData.pairCounts).length === 0) {
        warnings.push('co-change: empty co-change pairs in history');
      }
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

  // Graph coupling data — load from explicit option, env var, or conventional paths
  let graphCouplingData = opts.graphCouplingData ?? null;
  if (!graphCouplingData) {
    const candidatePaths = [
      opts.graphCouplingFile,
      process.env.ADLC_GRAPH_COUPLING_FILE,
      join(root, '.adlc', 'graph-coupling.json'),
      join(root, '.sdlc', 'artifacts', 'codebase_graph.json'),
      join(root, '.sdlc', 'artifacts', 'graph_coupling.json'),
    ].filter(Boolean);

    for (const p of candidatePaths) {
      if (existsSync(p)) {
        try {
          graphCouplingData = JSON.parse(readFileSync(p, 'utf8'));
          break;
        } catch (err) {
          warnings.push(`graph-coupling skipped: failed to parse ${p}: ${err.message}`);
        }
      }
    }
  }

  // Compute parallel-eligible pairs
  const pairs = parallelEligiblePairs(tickets);

  // Score each pair
  const pairResults = pairs.map(([a, b]) => {
    const { score, signal, hardVeto } = pairScore(a, b, {
      repoFiles,
      root,
      coChangeData,
      graphCouplingData,
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

  // Two different questions, two different numbers (#997).
  //
  // firstWaveWidth answers "how wide can I dispatch RIGHT NOW" — the greedy
  // largest set of pairwise-below-threshold tickets in wave 1. It is what the
  // --width gate has always measured, and it stays that way.
  //
  // scheduleWidth answers "how wide can this schedule EVER go" — the same
  // computation over every wave, taking the widest. For a foundation-first DAG
  // (ADLC.md D2) wave 1 holds one ticket, so firstWaveWidth is 1 while the
  // fan-out wave behind it may support many; reporting only the former told
  // operators the graph was serial when it was not.
  const wave1 = waves[0] ?? [];
  const firstWaveWidth = computeWaveWidth(wave1, pairResults, conflictThreshold);
  const scheduleWidth = waves.reduce(
    (widest, wave) =>
      Math.max(widest, computeWaveWidth(wave, pairResults, conflictThreshold)),
    0
  );

  // BackpressureWidth
  const backpressureWidth =
    buildMin !== null && mergeMin !== null && mergeMin > 0
      ? Math.round(buildMin / mergeMin)
      : null;

  // RecommendedWidth
  const candidates = [firstWaveWidth];
  if (backpressureWidth !== null) candidates.push(backpressureWidth);
  if (width !== null) candidates.push(width);
  const recommendedWidth = Math.min(...candidates);

  // Gate failures
  const gateFailures = [];

  // Fail if --width exceeds the wave-1 number (see #997: the gate is
  // deliberately measured against wave 1, not scheduleWidth)
  if (width !== null && width > firstWaveWidth) {
    gateFailures.push(
      `--width ${width} exceeds firstWaveWidth ${firstWaveWidth} — this gate ` +
        `measures wave 1 only (what can be dispatched now), not the whole ` +
        `schedule, whose widest wave is scheduleWidth ${scheduleWidth}`
    );
  }

  // Fail if any vetoed pair would be scheduled concurrently (both in same wave)
  const waveMap = new Map();
  for (let w = 0; w < waves.length; w++) {
    for (const id of waves[w]) waveMap.set(id, w);
  }
  const concurrentVetoes = pairResults.filter((pr) => {
    // A hard-vetoed pair (score 1.0, scope-overlap) is always high-risk; any
    // OTHER pair whose score has reached the conflict threshold (namespace
    // collision, import-radius, co-change) is high-risk too — the README's
    // documented contract ("vetoed/high-risk pair scheduled concurrently")
    // covers both, not only the hard veto.
    if (!pr.hardVeto && pr.score < conflictThreshold) return false;
    // Check if both tickets in the pair land in the same wave.
    const wA = waveMap.get(pr.a);
    const wB = waveMap.get(pr.b);
    return wA !== undefined && wB !== undefined && wA === wB;
  });
  if (concurrentVetoes.length > 0) {
    gateFailures.push(
      `${concurrentVetoes.length} high-risk pair(s) would run concurrently: ` +
        concurrentVetoes
          .map((p) => `${p.pair} (score ${p.score}, ${p.signal})`)
          .join(', ')
    );
  }

  return {
    pairs: pairResults,
    waves,
    mergeOrder: order,
    firstWaveWidth,
    scheduleWidth,
    // Deprecated alias of firstWaveWidth, kept because external consumers read
    // it (see README). It tracks wave 1, NOT scheduleWidth — repointing it
    // would silently change the meaning of every existing reader.
    certifiedWidth: firstWaveWidth,
    backpressureWidth,
    recommendedWidth,
    warnings,
    gateFailures,
    pullQueueNote: 'idle builders claim next unblocked',
  };
}

/**
 * Greedy largest set of pairwise-below-threshold tickets from ONE wave.
 * Build the conflict graph among that wave's tickets, then find a greedy
 * independent set. Nothing here is specific to wave 1 — it is called once for
 * wave 1 (firstWaveWidth) and once per wave (scheduleWidth).
 */
function computeWaveWidth(waveIds, pairResults, threshold) {
  if (waveIds.length === 0) return 0;

  // Build conflict adjacency set among this wave's tickets
  const conflicted = new Set();
  for (const pr of pairResults) {
    if (pr.score >= threshold || pr.hardVeto) {
      if (waveIds.includes(pr.a) && waveIds.includes(pr.b)) {
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
  for (let start = 0; start < waveIds.length; start++) {
    const chosen = [];
    // Start from `start` index to vary greedy seed
    const order = [
      ...waveIds.slice(start),
      ...waveIds.slice(0, start),
    ];
    for (const id of order) {
      if (!hasConflict(id, chosen)) chosen.push(id);
    }
    if (chosen.length > best) best = chosen.length;
  }
  return best;
}
