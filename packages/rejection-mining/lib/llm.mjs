// llm.mjs — LLM refinement for rejection-mining.
// One mid call per cluster to sharpen title + charter.

import { complete, extractJson } from '@adlc/core';

/**
 * Build the refinement prompt for a single cluster.
 *
 * @param {string} slug
 * @param {Array<{body: string, author: string, prNumber: number}>} signals
 * @returns {string}
 */
export function buildRefinementPrompt(slug, signals) {
  const samples = signals.slice(0, 5).map((s) => ({
    body: s.body.slice(0, 300),
    prNumber: s.prNumber,
  }));

  return `You are a senior engineering lead distilling recurring PR review objections into prosecution lenses.

Cluster slug: ${slug}
Sample objections (${signals.length} total):
${JSON.stringify(samples, null, 2)}

A "prosecution lens" is a focused angle of attack: when reviewing code, the lens tells the reviewer exactly what to try to disprove.

Output ONLY valid JSON matching this schema (no extra text, no markdown):
{
  "title": "<short human-readable title for this pattern, max 60 chars>",
  "charter": "<one or two sentences: 'when prosecuting a diff, specifically attempt to refute: ...' — focus on the concrete failure pattern, max 250 chars>"
}`;
}

/**
 * Refine a single cluster via LLM.
 * Returns { title, charter } or null on failure.
 *
 * @param {string} slug
 * @param {Array<{body: string}>} signals
 * @returns {Promise<{title: string, charter: string}|null>}
 */
export async function refineCluster(slug, signals) {
  const prompt = buildRefinementPrompt(slug, signals);
  const raw = await complete({ tier: 'mid', prompt, maxTokens: 512 });
  const parsed = extractJson(raw);
  if (parsed && parsed.title && parsed.charter) return parsed;
  return null;
}

/**
 * Refine multiple clusters (one mid call each).
 * Returns Map<clusterIndex, {title, charter}>.
 * Failures are logged but do not throw.
 *
 * @param {Array<{slug: string, indices: number[]}>} clusters
 * @param {Array<{body: string}>} signals
 * @returns {Promise<Map<number, {title: string, charter: string}>>}
 */
export async function refineClusters(clusters, signals) {
  const results = new Map();

  for (const [idx, cluster] of clusters.entries()) {
    const clusterSignals = cluster.indices.map((i) => signals[i]);
    try {
      const refined = await refineCluster(cluster.slug, clusterSignals);
      if (refined) results.set(idx, refined);
    } catch (err) {
      console.error(
        `rejection-mining: LLM refinement failed for cluster "${cluster.slug}": ${err.message}`
      );
    }
  }

  return results;
}

/**
 * Build all prompts for --prompt-only mode.
 *
 * @param {Array<{slug: string, indices: number[]}>} clusters
 * @param {Array<{body: string}>} signals
 * @returns {string[]}
 */
export function buildAllPrompts(clusters, signals) {
  return clusters.map((cluster) => {
    const clusterSignals = cluster.indices.map((i) => signals[i]);
    return buildRefinementPrompt(cluster.slug, clusterSignals);
  });
}
