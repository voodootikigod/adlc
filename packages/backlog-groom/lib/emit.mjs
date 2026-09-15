/**
 * The emitted groomed set (spec §3.9).
 *
 * This is the ONLY external contract this half has: `issue-lanes` adoption is a
 * separate ticket, so there is no live consumer to validate against yet. That is
 * why the set carries a schema version and is pinned against a committed
 * fixture — a shape change without a version bump has to fail loudly here, or
 * the handoff drifts silently until the day someone tries to consume it.
 */

/** Bump when the emitted shape changes. AC12 pins this against a fixture. */
export const EMIT_SCHEMA_VERSION = 4;

/** The exact top-level key set of an emitted document, in order. */
export const EMIT_KEYS = Object.freeze([
  'schemaVersion',
  'generatedFor',
  'coverage',
  'truncated',
  'issues',
  'clusters',
  'unclustered',
  'relations',
  'relationFilter',
  'proposals',
]);

/**
 * The exact key set of one emitted issue row.
 *
 * `contentHash` is present because the WRITE path's replay protection is keyed
 * on it (§3.6) and its idempotence marker embeds it (§3.8). Without it in the
 * emitted set, a consumer would have to recompute the hash — re-reading every
 * cited path — and any drift between the two computations would silently break
 * both the one-shot guarantee and the resume-don't-re-comment rule. It is
 * `null` for an issue with no referenced paths, which §2.2 requires to be
 * distinguishable rather than absent.
 */
export const ISSUE_KEYS = Object.freeze(['number', 'title', 'url', 'route', 'verdict', 'evidence', 'contentHash', 'updatedAt', 'frozen', 'rank', 'labels', 'units']);

/**
 * Build the groomed set.
 *
 * Key order is fixed and every key is always present — an emitted document with
 * an absent key would let a consumer distinguish "no relations" from "relations
 * not computed" only by guessing.
 */
export function emitGroomedSet({
  generatedFor = null,
  coverage,
  truncated = null,
  rows = [],
  clusters = [],
  unclustered = [],
  relations = [],
  relationFilter = null,
  proposals = [],
} = {}) {
  return {
    schemaVersion: EMIT_SCHEMA_VERSION,
    generatedFor,
    coverage,
    truncated,
    issues: rows.map((r) => ({
      number: r.number,
      title: r.title ?? '',
      url: r.url ?? null,
      route: r.verified?.route ?? r.classified?.route ?? 'unverifiable',
      verdict: r.verified?.verdict ?? 'unverifiable',
      evidence: r.verified?.evidence ?? null,
      contentHash: r.contentHash ?? null,
      // The ISSUE's own revision. contentHash binds the verdict to the code; this
      // binds it to the issue text the verdict was formed from, which can change
      // while the repository does not.
      updatedAt: r.updatedAt ?? null,
      // Whether any cited path is frozen by the profile. Emitted rather than
      // recomputed downstream: the write path has no access to the citations,
      // and a policy it cannot see is a policy it cannot enforce.
      frozen: r.frozen === true,
      rank: r.rank ?? null,
      labels: r.labels ?? [],
      units: r.units ?? [],
    })),
    clusters,
    unclustered,
    relations,
    relationFilter,
    proposals,
  };
}
