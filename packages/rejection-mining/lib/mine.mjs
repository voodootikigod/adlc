// mine.mjs — core mining pipeline for rejection-mining.
// Orchestrates gh fetching, signal extraction, and clustering.

import { fetchPRList, fetchPRDetail, fetchPRsGraphQL } from './gh.mjs';
import { extractBodies, filterNegativeSignals } from './signal.mjs';
import { clusterSignals, deriveSlug } from './cluster.mjs';

/**
 * Fetch all PR signals using the injectable ghRunner.
 * Prefers a single paginated `gh api graphql` query (1 call for <=100 PRs)
 * and falls back to `gh pr list` + `gh pr view` when GraphQL is unavailable.
 * Returns { signals, totalPRs, skippedPRs, firstError }
 *
 * @param {object} opts
 * @param {number} opts.limit
 * @param {function} opts.ghRunner
 * @param {string} [opts.repo]
 * @returns {{ signals: Array, totalPRs: number, skippedPRs: number, firstError: string|null }}
 */
export async function fetchSignals({ limit, ghRunner, repo }) {
  try {
    const gqlPrs = fetchPRsGraphQL(limit, ghRunner, { repo });
    const allSignals = [];
    let skippedPRs = 0;
    let firstError = null;
    for (const pr of gqlPrs) {
      let detail = pr;
      if (pr.truncated) {
        try {
          detail = fetchPRDetail(pr.number, ghRunner, { repo });
        } catch (err) {
          skippedPRs++;
          if (firstError === null) {
            const stderr = err?.stderr ? String(err.stderr).trim() : '';
            firstError = (stderr || err?.message || String(err)).trim().replace(/\r?\n.*/s, '');
          }
          continue;
        }
      }
      const bodies = extractBodies(detail, pr.number);
      allSignals.push(...filterNegativeSignals(bodies));
    }
    return {
      signals: allSignals,
      totalPRs: gqlPrs.length,
      skippedPRs,
      firstError,
    };
  } catch {
    // Fall back to `pr list` + `pr view` when GraphQL is unavailable or unsupported.
  }

  const prs = fetchPRList(limit, ghRunner, { repo });
  if (!Array.isArray(prs) || prs.length === 0) {
    return { signals: [], totalPRs: 0, skippedPRs: 0, firstError: null };
  }

  const allSignals = [];
  let skippedPRs = 0;
  let firstError = null;

  for (const pr of prs) {
    let detail;
    try {
      detail = fetchPRDetail(pr.number, ghRunner, { repo });
    } catch (err) {
      skippedPRs++;
      if (firstError === null) {
        const stderr = err?.stderr ? String(err.stderr).trim() : '';
        firstError = (stderr || err?.message || String(err)).trim().replace(/\r?\n.*/s, '');
      }
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
    firstError,
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
