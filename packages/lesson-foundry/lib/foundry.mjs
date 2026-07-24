// Core orchestration logic for lesson-foundry — pure/near-pure functions.
// Reads findings, clusters, routes, and produces emission plans.

import { readFileSync, readdirSync } from 'node:fs';
import { readEntries } from '@adlc/core';
import { clusterFindings } from './cluster.mjs';
import { routeCluster, clusterName, clusterId, clusterMembers } from './route.mjs';
import { planEmissions } from './emit.mjs';

/**
 * Legacy marker: identifies a spec-gap cluster's question inside the
 * interrogation template by its human-readable slug. Kept for back-compat with
 * lessons committed before the stable id existed. Must stay in sync with
 * buildSpecGapLine in emit.mjs.
 */
function specGapMarker(name) {
  return `cluster: ${name}`;
}

/**
 * Stable marker: identifies a spec-gap cluster by its prose-independent id, so a
 * reworded question that dropped the slug annotation is still credited. Must stay
 * in sync with buildSpecGapLine in emit.mjs.
 */
function specGapIdMarker(id) {
  return `cluster-id: ${id}`;
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
      const id = clusterId(clusterFinds);
      const members = clusterMembers(clusterFinds);
      const sample = clusterFinds[0]?.desc ?? '';
      return { id, members, name, indices, size: indices.length, route, sample };
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
 * Banking is credited by the STABLE cluster id first (so a hand-refined lesson —
 * a reworded spec-gap question, or a lint/skill artifact renamed away from its
 * slug — is still recognized), then by the legacy slug (so lessons committed
 * before the id existed are not orphaned). A cluster carrying no id (older
 * callers) falls back to slug-only detection.
 *
 * `readFile`/`readDir` are injected for testability; they default to real fs reads
 * that return '' / [] when the path is absent or unreadable.
 */
export function findUnbankedClusters(
  clusters,
  outDir,
  existsSync,
  readFile = defaultReadFile,
  readDir = defaultReadDir,
  minSize = 2
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

  // List the output dir once; used to credit an id-stamped artifact whose
  // slug-derived filename has drifted or been renamed during refinement.
  let dirEntries = null;
  const listDir = () => {
    if (dirEntries === null) dirEntries = readDir(outDir);
    return dirEntries;
  };
  // Is there any `suffix` file in outDir whose content carries this cluster's id?
  // Credit an artifact that shares a MEMBER KEY with this cluster (the durable
  // identity), or that carries the legacy derived id. Overlap is what survives the
  // cluster gaining a member (a recurrence) or a merge introducing an earlier one —
  // neither removes the members an existing lesson already covers.
  const hasStampedArtifact = (suffix, id, members = []) => {
    const keys = [...members, ...(id ? [id] : [])];
    if (keys.length === 0) return false; // nothing to match on; fall back to slug only
    for (const entry of listDir()) {
      if (!entry.endsWith(suffix)) continue;
      const content = readFile(`${outDir}/${entry}`);
      if (content && keys.some((k) => content.includes(k))) return true;
    }
    return false;
  };

  return clusters.filter((cluster) => {
    const { route, name, id, members = [] } = cluster;
    const suffix = route === 'lint' ? '.lint.json' : route === 'skill' ? '.SKILL.md' : null;
    const template = suffix ? null : getTemplate();

    // Legacy crediting (pre-overlap lessons): a slug-named defense file, the slug
    // marker, or the derived cluster-id banks the whole cluster.
    if (suffix && existsSync(`${outDir}/${name}${suffix}`)) return false;
    if (!suffix && template.includes(specGapMarker(name))) return false;
    if (id && (suffix ? hasStampedArtifact(suffix, id, []) : template.includes(specGapIdMarker(id)))) return false;

    if (members.length === 0) return true; // nothing to reason about → surface it

    // COVERAGE INVARIANT. Crediting the cluster because *any one* member is covered
    // would let a merged cluster be banked by a defense for only part of it: clustering
    // is transitive, so a bridging finding can fuse a defended pattern with an
    // undefended one, and existential overlap would silently absorb the undefended
    // half — exactly what this gate exists to catch.
    //
    // Instead, look at what is NOT covered. A recurrence of a defended pattern leaves a
    // small uncovered remainder (the new occurrences); a fused-in undefended pattern
    // leaves a remainder large enough to be a cluster in its own right. So reuse the
    // caller's own clustering threshold: an uncovered remainder that would itself
    // qualify as a cluster is an undefended cluster, whatever it is bundled with.
    const isCovered = (m) => (suffix ? hasStampedArtifact(suffix, null, [m]) : template.includes(m));
    const uncovered = members.filter((m) => !isCovered(m));
    return uncovered.length >= minSize;
  });
}

function defaultReadFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function defaultReadDir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
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
