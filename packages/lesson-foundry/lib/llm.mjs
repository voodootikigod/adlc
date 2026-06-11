// LLM refinement helpers for lesson-foundry.
// Builds prompts and calls complete() for cluster wording refinement.

import { complete, extractJson } from '../../core/index.mjs';

/**
 * Build the refinement prompt for a single cluster.
 * findings: array of finding objects.
 */
export function buildRefinementPrompt(clusterName, findings) {
  const samples = findings.slice(0, 5).map((f) => ({
    desc: f.desc,
    category: f.category,
    severity: f.severity,
    file: f.file,
  }));

  return `You are a senior engineer distilling recurring code-review findings into a permanent defense rule.

Cluster name: ${clusterName}
Sample findings (${findings.length} total):
${JSON.stringify(samples, null, 2)}

Output ONLY valid JSON matching this schema (no extra text):
{
  "name": "<slug-style-name, max 50 chars>",
  "description": "<one-sentence description suitable as a skill trigger, max 120 chars>",
  "rule": "<actionable rule sentence for the skill body, max 200 chars>"
}`;
}

/**
 * Refine a single cluster via LLM.
 * Returns { name, description, rule } or null on failure.
 */
export async function refineCluster(clusterName, findings) {
  const prompt = buildRefinementPrompt(clusterName, findings);
  const raw = await complete({ tier: 'mid', prompt, maxTokens: 512 });
  return extractJson(raw);
}

/**
 * Refine multiple clusters, one mid call each.
 * Returns Map<clusterIndex, {name, description, rule}>.
 * Failures are logged but do not throw.
 */
export async function refineClusters(clusters, allFindings) {
  const results = new Map();

  for (const [idx, cluster] of clusters.entries()) {
    const findings = cluster.indices.map((i) => allFindings[i]);
    try {
      const refined = await refineCluster(cluster.name, findings);
      if (refined && refined.name && refined.description && refined.rule) {
        results.set(idx, refined);
      }
    } catch (err) {
      // Non-fatal — cluster proceeds with unrefined wording
      console.error(`lesson-foundry: LLM refinement failed for cluster "${cluster.name}": ${err.message}`);
    }
  }

  return results;
}

/**
 * Build all prompts for --prompt-only mode.
 */
export function buildAllPrompts(clusters, allFindings) {
  return clusters.map((cluster) => {
    const findings = cluster.indices.map((i) => allFindings[i]);
    return buildRefinementPrompt(cluster.name, findings);
  });
}
