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
 * Crediting works off the MEMBER KEYS a defense records, not a derived key: no key
 * derived from the member set can be stable, because the set grows on every
 * recurrence and can also gain an earlier member when a branch merges.
 *
 * When the matched defense records member keys, the coverage invariant decides —
 * a cluster is undefended when the members it does NOT cover would themselves form
 * a cluster (see below). When the defense matched only by cluster-id or slug — a
 * pre-overlap or hand-refined lesson, where coverage cannot be evaluated — the
 * whole cluster is credited, which is the only remaining use of those markers.
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
  return clusters.filter((cluster) => {
    const { route, name, id, members = [] } = cluster;
    const suffix = route === 'lint' ? '.lint.json' : route === 'skill' ? '.SKILL.md' : null;
    const template = suffix ? null : getTemplate();

    // A slug-NAMED defense file is a whole-cluster legacy credit of its own.
    if (suffix && existsSync(`${outDir}/${name}${suffix}`)) return false;

    // Gather the artifact content that actually references THIS cluster — by member
    // key, by the derived id, or by the legacy slug. For spec-gap the template holds
    // many lessons, so match per LINE; one lesson's marker must not credit another's.
    const candidates = suffix
      ? listDir().filter((e) => e.endsWith(suffix)).map((e) => readFile(`${outDir}/${e}`) || '')
      : template.split('\n');
    const related = candidates.filter((c) =>
      members.some((m) => c.includes(m))
      || (id && c.includes(specGapIdMarker(id)))
      || c.includes(specGapMarker(name)));

    if (related.length === 0) return true; // nothing defends this cluster

    // Which of this cluster's members does the matched defense actually record?
    const covered = members.filter((m) => related.some((c) => c.includes(m)));

    // No member keys recorded → the defense matched by id or slug alone. That is a
    // pre-overlap or hand-refined lesson, and coverage cannot be evaluated against it,
    // so credit the whole cluster (this is the ONLY path legacy matches may bank on).
    if (covered.length === 0) return false;

    // COVERAGE INVARIANT — deliberately evaluated INSTEAD OF, not after, an id match.
    // Every normally emitted lesson stamps the id AND the member keys, and clusterId is
    // anchored on the founding occurrence, so a fused cluster still matches the old id.
    // Letting that id match return "banked" first made this invariant unreachable in
    // the normal path. Crediting on *any* covered member fails the same way, because
    // clustering is transitive and a bridging finding can fuse two patterns.
    //
    // So judge by what is NOT covered: a recurrence leaves a small uncovered remainder
    // (the new occurrences), while a fused-in undefended pattern leaves one large
    // enough to be a cluster in its own right. Reuse the caller's clustering threshold.
    return members.length - covered.length >= minSize;
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
