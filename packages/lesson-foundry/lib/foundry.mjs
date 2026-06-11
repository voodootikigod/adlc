// Core orchestration logic for lesson-foundry — pure/near-pure functions.
// Reads findings, clusters, routes, and produces emission plans.

import { readFileSync } from 'node:fs';
import { readEntries } from '../../core/index.mjs';
import { clusterFindings } from './cluster.mjs';
import { routeCluster, clusterName } from './route.mjs';
import { planEmissions } from './emit.mjs';

/**
 * Marker that uniquely identifies a spec-gap cluster's question inside the
 * interrogation template. Must stay in sync with buildSpecGapLine in emit.mjs.
 */
function specGapMarker(name) {
  return `cluster: ${name}`;
}

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
 * Check gate condition: is every cluster actually defended?
 *
 * - lint/skill clusters are banked when their dedicated defense file exists.
 * - spec-gap clusters are banked ONLY when the interrogation template actually
 *   contains this cluster's specific question (content check) — not merely
 *   because the template file exists. Otherwise the first banked spec-gap would
 *   silently defend every future spec-gap cluster.
 *
 * `readFile` is injected for testability; defaults to a real fs read that
 * returns '' when the file is absent/unreadable.
 */
export function findUnbankedClusters(
  clusters,
  outDir,
  existsSync,
  readFile = defaultReadFile
) {
  const templatePath = `${outDir}/interrogation-template.md`;
  // Read the template once; reuse across spec-gap clusters.
  let templateContent = null;
  const getTemplate = () => {
    if (templateContent === null) {
      templateContent = existsSync(templatePath) ? readFile(templatePath) : '';
    }
    return templateContent;
  };

  return clusters.filter((cluster) => {
    const route = cluster.route;
    const name = cluster.name;

    if (route === 'lint') {
      return !existsSync(`${outDir}/${name}.lint.json`);
    }
    if (route === 'skill') {
      return !existsSync(`${outDir}/${name}.SKILL.md`);
    }
    // spec-gap: banked only if this cluster's question is present in the template.
    return !getTemplate().includes(specGapMarker(name));
  });
}

function defaultReadFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
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
