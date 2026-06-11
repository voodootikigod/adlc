// Core orchestration logic for lesson-foundry — pure/near-pure functions.
// Reads findings, clusters, routes, and produces emission plans.

import { readEntries } from '../../core/index.mjs';
import { clusterFindings } from './cluster.mjs';
import { routeCluster, clusterName } from './route.mjs';
import { planEmissions } from './emit.mjs';

/**
 * Load findings from the ledger.
 * Returns { findings, skipped, filtered }
 * - findings: valid entries with verdict !== 'killed'
 * - skipped: count of malformed lines
 * - filtered: count of killed entries
 */
export function loadFindings(ledgerName, dir) {
  const { entries, skipped } = readEntries(ledgerName, dir);

  const live = [];
  let filtered = 0;

  for (const e of entries) {
    if (e.verdict === 'killed') {
      filtered++;
    } else {
      live.push(e);
    }
  }

  return { findings: live, skipped: skipped.length, filtered };
}

/**
 * Build clusters from findings.
 * Returns array of cluster objects:
 * { name, indices, size, route, sample }
 */
export function buildClusters(findings, minSize, threshold = 0.5) {
  if (findings.length === 0) return [];

  const rawClusters = clusterFindings(findings, threshold);

  return rawClusters
    .filter((indices) => indices.length >= minSize)
    .map((indices) => {
      const clusterFinds = indices.map((i) => findings[i]);
      const route = routeCluster(clusterFinds);
      const name = clusterName(clusterFinds);
      const sample = clusterFinds[0]?.desc ?? '';
      return { name, indices, size: indices.length, route, sample };
    });
}

/**
 * Check gate condition: does every cluster have a defense file already on disk?
 * Returns array of clusters that are unbanked (no defense file found).
 */
export function findUnbankedClusters(clusters, outDir, existsSync) {
  return clusters.filter((cluster) => {
    const route = cluster.route;
    const name = cluster.name;

    let defenseFile;
    if (route === 'lint') {
      defenseFile = `${outDir}/${name}.lint.json`;
    } else if (route === 'skill') {
      defenseFile = `${outDir}/${name}.SKILL.md`;
    } else {
      // spec-gap: check interrogation-template.md exists
      defenseFile = `${outDir}/interrogation-template.md`;
    }

    return !existsSync(defenseFile);
  });
}

/**
 * Run the full foundry pipeline (pure orchestration — no I/O beyond ledger read).
 * Returns { findings, skipped, filtered, clusters, plan, unbanked }
 */
export async function runFoundry({
  ledgerName,
  ledgerDir,
  minSize,
  outDir,
  threshold = 0.5,
  llmRefinements = new Map(),
}) {
  const { findings, skipped, filtered } = loadFindings(ledgerName, ledgerDir);
  const clusters = buildClusters(findings, minSize, threshold);
  const plan = planEmissions(clusters, findings, outDir, llmRefinements);

  return { findings, skipped, filtered, clusters, plan };
}
