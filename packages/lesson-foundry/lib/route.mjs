// Routing logic for lesson-foundry — pure functions.
// Given a cluster of findings, decide the cheapest permanent defense.

import { sha256 } from '@adlc/core';

// Categories that route to SKILL
const SKILL_CATEGORIES = new Set(['convention', 'pattern', 'architecture', 'style']);

// Regex to detect quoted literals or recognizable marker patterns in desc/evidence
// Matches "quoted text", 'quoted text', `backtick text`, or common code patterns
const QUOTED_RE = /["'`][^"'`]{1,80}["'`]/;
// Recognizable marker patterns: TODO, FIXME, #noqa, eslint-disable, etc.
const MARKER_RE = /\b(todo|fixme|hack|noqa|eslint-disable|@ts-ignore|suppress|eslint-enable)\b/i;

/**
 * Determine whether a cluster should route to LINT.
 * A cluster routes to LINT if any member's desc (or evidence field) contains:
 * - A quoted literal string
 * - A recognizable marker pattern
 *
 * findings: array of finding objects belonging to this cluster.
 */
export function shouldRouteLint(findings) {
  for (const f of findings) {
    const text = (f.desc ?? '') + ' ' + (f.evidence ?? '');
    if (QUOTED_RE.test(text) || MARKER_RE.test(text)) return true;
  }
  return false;
}

/**
 * Determine route for a cluster.
 * Priority: LINT > SKILL > SPEC-GAP
 * Returns 'lint' | 'skill' | 'spec-gap'
 */
export function routeCluster(findings) {
  if (shouldRouteLint(findings)) return 'lint';

  // Check if any finding's category maps to SKILL
  for (const f of findings) {
    const cat = (f.category ?? '').toLowerCase().trim();
    if (SKILL_CATEGORIES.has(cat)) return 'skill';
  }

  return 'spec-gap';
}

/**
 * Canonical JSON of an object with keys sorted at every level, so a finding's
 * hash never depends on the order its fields happened to be recorded in.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/**
 * Content-stable hash of a single finding, derived only from its own recorded
 * fields — nothing a human does to a scaffolded lesson can move it.
 */
export function findingHash(finding) {
  return sha256(canonicalJson(finding ?? null));
}

/**
 * STABLE cluster id: sha256 over the SORTED per-finding hashes. Sorting makes it
 * order-independent (cluster membership is not emitted in a guaranteed order), and
 * deriving it purely from the findings makes it prose-independent — so banking
 * survives both re-clustering that reorders members and a human rewording the
 * scaffolded lesson. This is the durable key the gate credits, distinct from the
 * human-readable clusterName slug (which is derived from the first finding's desc
 * and drifts). Truncated to 64 bits: ample to avoid collision across the handful
 * of clusters a ledger ever holds, short enough to embed in a marker.
 */
/**
 * The cluster's MEMBER KEYS — the durable banking identity.
 *
 * No key DERIVED from the current member set can be stable, because the set changes in
 * both directions: a recurrence appends a member, and — now that the ledger is tracked
 * in git — a branch merge can introduce a member with an EARLIER timestamp. Keying on
 * the whole set breaks on growth; keying on the earliest member breaks on merge.
 *
 * So banking does not derive a key at all. A lesson records the member keys it was
 * distilled from, and a cluster counts as defended when it still shares a member with
 * that lesson. Overlap survives both growth and out-of-order merges, because neither
 * REMOVES the members the lesson already covers.
 */
export function clusterMembers(findings) {
  return (findings ?? []).filter(Boolean).map((f) => findingHash(f).slice(0, 12)).sort();
}

/**
 * Informational, human-facing cluster key. Retained so lessons banked before the
 * overlap scheme keep being credited, and for `--json` output — but it is NOT the
 * banking identity (see clusterMembers for why a derived key cannot be stable).
 */
export function clusterId(findings) {
  const list = (findings ?? []).filter(Boolean);
  if (list.length === 0) return sha256('adlc-cluster-v2\n').slice(0, 16);
  // Identity is the occurrence that FOUNDED the cluster — deliberately NOT the whole
  // member set. A recurring pattern accumulates members over time; that is the ledger's
  // normal lifecycle, not an edge case. Hashing every member meant one more occurrence
  // of an ALREADY-DEFENDED pattern produced a different id, orphaning the lesson's
  // marker and reporting the cluster undistilled again — the precise failure this id
  // exists to prevent. The earliest member is invariant under append.
  //
  // Ties on `ts` break on the content hash so the choice is deterministic, and sorting
  // means input order cannot affect the result. (The ledger is append-only; pruning the
  // founding occurrence would re-key the cluster, which is why entries are never
  // removed.)
  const founding = list
    .map((f) => ({ ts: String(f?.ts ?? ''), hash: findingHash(f) }))
    .sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0)))[0];
  return sha256(`adlc-cluster-v2\n${founding.hash}`).slice(0, 16);
}

/**
 * Generate a slug/name for a cluster from its sample finding.
 * Used as file basename.
 */
export function clusterName(findings) {
  const desc = findings[0]?.desc ?? 'unnamed';
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'cluster';
}

/**
 * Extract the most prominent quoted literal or marker keyword from findings
 * (for lint pattern generation).
 * Priority: quoted literal > marker keyword > null
 */
export function extractLiteralPattern(findings) {
  // First try quoted literals
  for (const f of findings) {
    const text = (f.desc ?? '') + ' ' + (f.evidence ?? '');
    const match = text.match(/["'`]([^"'`]{1,80})["'`]/);
    if (match) return match[1];
  }
  // Fallback: extract recognizable marker keyword
  for (const f of findings) {
    const text = (f.desc ?? '') + ' ' + (f.evidence ?? '');
    const match = text.match(/\b(TODO|FIXME|HACK|noqa|eslint-disable|@ts-ignore|suppress|eslint-enable)\b/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/**
 * Escape a string for use in a regex (grep pattern).
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
