// mine.mjs — core mining pipeline for rejection-mining.
// Orchestrates gh fetching, signal extraction, and clustering.

import { fetchPRList, fetchPRDetail } from './gh.mjs';
import { extractBodies, filterNegativeSignals } from './signal.mjs';
import { clusterSignals, deriveSlug } from './cluster.mjs';

/**
 * Fetch all PR signals using the injectable ghRunner.
 * Returns { signals, totalPRs, skippedPRs }
 *
 * @param {object} opts
 * @param {number} opts.limit
 * @param {function} opts.ghRunner
 * @returns {{ signals: Array, totalPRs: number, skippedPRs: number }}
 */
export async function fetchSignals({ limit, ghRunner }) {
  const prs = fetchPRList(limit, ghRunner);
  if (!Array.isArray(prs) || prs.length === 0) {
    return { signals: [], totalPRs: 0, skippedPRs: 0 };
  }

  const allSignals = [];
  let skippedPRs = 0;

  for (const pr of prs) {
    let detail;
    try {
      detail = fetchPRDetail(pr.number, ghRunner);
    } catch (err) {
      skippedPRs++;
      continue;
    }

    const bodies = extractBodies(detail, pr.number);
    const negatives = filterNegativeSignals(bodies);
    allSignals.push(...negatives);
  }

  return {
    signals: allSignals,
    totalPRs: prs.length,
    skippedPRs,
  };
}

/**
 * Build clusters from signals with slugs, meeting --min threshold.
 *
 * @param {Array<{body: string}>} signals
 * @param {number} minSize
 * @param {number} threshold
 * @returns {Array<{slug: string, indices: number[], count: number, prNumbers: Set, title?: string}>}
 */
export function buildClusters(signals, minSize, threshold = 0.4) {
  if (signals.length === 0) return [];

  const rawClusters = clusterSignals(signals, threshold);

  return rawClusters
    .filter((indices) => indices.length >= minSize)
    .map((indices) => {
      const clusterSigs = indices.map((i) => signals[i]);
      const slug = deriveSlug(clusterSigs);
      const prNumbers = new Set(clusterSigs.map((s) => s.prNumber));
      return {
        slug,
        indices,
        count: indices.length,
        prNumbers,
      };
    });
}
