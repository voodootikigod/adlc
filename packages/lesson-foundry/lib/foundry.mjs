// Core orchestration logic for lesson-foundry — pure/near-pure functions.
// Reads findings, clusters, routes, and produces emission plans.

import { readFileSync, readdirSync } from 'node:fs';
import { readEntries } from '@adlc/core';
import { clusterFindings } from './cluster.mjs';
import { routeCluster, clusterName, clusterId, clusterMembers, findingHash } from './route.mjs';
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
 * Does an artifact record member keys at all? Spec-gap lines and skill frontmatter
 * carry `cluster-members:`; the lint descriptor is JSON with a `members` array. Used
 * to tell a pre-overlap defense (creditable by id/slug) from a current one that simply
 * belongs to a different cluster.
 */
const RECORDS_MEMBERS = /cluster-members|"members"\s*:/;

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
  let malformed = 0;

  for (const e of entries) {
    // Defense in depth against a non-finding entry that bypassed the write boundary
    // (a hand edit, a merge artifact): a bare null/scalar/array or a finding with no
    // desc has no clustering key. Skip it rather than dereference `.verdict` on null.
    if (e === null || typeof e !== 'object' || Array.isArray(e) || typeof e.desc !== 'string' || e.desc.trim() === '') {
      malformed++;
      continue;
    }
    if (e.verdict === 'killed') {
      filtered++;
    } else {
      live.push(e);
    }
  }

  return { findings: live, skipped: skipped.length + malformed, filtered };
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
  minSize = 2,
  findings = null,
  threshold = 0.5
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

    // The slug-NAMED defense file. Its mere existence must NOT credit the cluster:
    // every normally emitted lint/skill artifact is slug-named, so an existence check
    // here would short-circuit the coverage invariant below for all of them — the same
    // bypass the cluster-id match caused for spec-gap. Read it instead: if it records
    // member keys it takes part in coverage like any other artifact; only when it
    // records none (a pre-overlap artifact, where coverage cannot be evaluated) does
    // its existence stand as a whole-cluster legacy credit.
    if (suffix && existsSync(`${outDir}/${name}${suffix}`)) {
      const slugContent = readFile(`${outDir}/${name}${suffix}`) || '';
      // Grant filename-based legacy credit ONLY to an artifact that records no member
      // metadata (genuinely pre-overlap). If it records members — whether ours or a
      // DIFFERENT cluster's that merely shares the 50-char-truncated slug — fall through
      // to the coverage/collision logic, which credits it only for the members it
      // actually covers. Checking `!members.some(...)` here was the bug: a colliding
      // artifact records none of OUR members, so it slipped through as a false credit.
      if (!RECORDS_MEMBERS.test(slugContent)) return false;
    }

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

    // The defense matched by id or slug but covers none of THIS cluster's members.
    // Two very different situations, and they must not be conflated:
    //   - it records NO member keys at all → a pre-overlap or hand-refined lesson;
    //     coverage cannot be evaluated against it, so credit the whole cluster. This
    //     is the only remaining thing id/slug markers may bank on.
    //   - it DOES record member keys, just not ours → it belongs to a different
    //     cluster that merely shares a slug (clusterName truncates to 50 chars, so
    //     distinct patterns can collide) or an id. Crediting from it would be a false
    //     pass, so leave this cluster unbanked.
    if (covered.length === 0) return related.some((c) => RECORDS_MEMBERS.test(c));

    // COVERAGE INVARIANT — deliberately evaluated INSTEAD OF, not after, an id match.
    // Every normally emitted lesson stamps the id AND the member keys, and clusterId is
    // anchored on the founding occurrence, so a fused cluster still matches the old id.
    // Letting that id match return "banked" first made this invariant unreachable in
    // the normal path. Crediting on *any* covered member fails the same way, because
    // clustering is transitive and a bridging finding can fuse two patterns.
    //
    // The question is whether the UNCOVERED members form a cluster of their own. If they
    // do, an undefended pattern was fused in and the cluster must be surfaced; if they
    // are just stray recurrences that each bridged to the defended pattern, it stays
    // banked. When the caller supplies the findings, decide this EXACTLY by
    // reclustering the uncovered findings — a bare count is only a proxy and misfires
    // when unrelated occurrences bridge to different covered members without clustering
    // with each other.
    const coveredSet = new Set(covered);
    if (Array.isArray(findings) && Array.isArray(cluster.indices)) {
      const uncoveredFindings = cluster.indices
        .map((i) => findings[i])
        .filter((f) => f && !coveredSet.has(findingHash(f).slice(0, 12)));
      if (uncoveredFindings.length < minSize) return false; // too few to form a cluster
      const subclusters = clusterFindings(uncoveredFindings, threshold);
      return subclusters.some((sub) => sub.length >= minSize);
    }
    // No findings available (a caller that passes clusters only): fall back to the count
    // proxy — sound for a recurrence vs a wholesale fusion, imprecise only for the
    // bridged-but-unrelated case the reclustering path above handles.
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
