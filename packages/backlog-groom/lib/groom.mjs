/**
 * The read pipeline, assembled (spec §3.1–§3.5, §3.9, §4).
 *
 *   fetch → classify → verify → cluster → rank → relabel proposals → emit
 *
 * Every external effect is injected, so the whole pipeline is testable without a
 * network, a git tree, or a GitHub token.
 *
 * THIS HALF WRITES NOTHING TO GITHUB. The gate (§3.6), the autonomy floor
 * (§3.7) and execution (§3.8) belong to the write path. Proposals are emitted
 * for it to decide on; nothing here applies them.
 */

import { fetchIssues } from './fetch.mjs';
import { classifyIssue } from './classify.mjs';
import { verifyIssue, headCommit } from './verify.mjs';
import { contentHash } from './content-hash.mjs';
import { cacheGet, cachePut } from './cache.mjs';
import { clusterIssues, unitsForIssue } from './cluster.mjs';
import { rankIssue } from './rank.mjs';
import { relabelProposals } from './relabel.mjs';
import { candidatePairs, emitRelations } from './relations.mjs';
import { coverageOf } from './report.mjs';
import { emitGroomedSet } from './emit.mjs';
import { globMatch } from './cluster.mjs';

/**
 * Total citations one sweep will verify.
 *
 * The per-issue cap bounds a single hostile body; this bounds the BACKLOG. 500
 * issues at 50 citations each is 25,000 references and roughly three synchronous
 * git subprocesses apiece, which is a run that never finishes in any useful
 * sense. Past the budget, remaining issues are treated as truncated — so they
 * can never verify `fixed` — and the report says the run was incomplete rather
 * than presenting a partial sweep as a whole one.
 */
export const MAX_TOTAL_REFERENCES = 5000;

/**
 * Run the read pipeline.
 *
 * @param {object} o
 * @param {object} o.profile - a parsed profile
 * @param {object} [o.cache] - mutable cache store; omitted means no caching
 * @param {Function} [o.judge] - relation judge supplied by the skill; without
 *   one, no relations are emitted (a filter hit is not a relation)
 * @param {object} [o.io] - fetch/fs/git seams
 */
export function groom({ profile, cache = null, judge = null, io = {}, relationThreshold = 0.2, generatedFor = null } = {}) {
  // What the run actually described. Verification reads HEAD rather than the
  // working tree, so the emitted set names the commit it read — without it a
  // consumer cannot tell which revision a verdict refers to.
  const describedCommit = generatedFor ?? (io.headCommit ? io.headCommit() : headCommit());
  // Every git read below uses this resolved sha, not the moving `HEAD` ref, so a
  // checkout switching branches mid-run cannot mix revisions into one set.
  if (!describedCommit) {
    // Failing to resolve a revision is not a backlog with nothing to verify: it
    // means the tool cannot read the code at all. Degrading to a full sweep of
    // `unverifiable` verdicts and exiting 0 would hand the operator a
    // normal-looking report for a run that examined nothing.
    return { ok: false, unconsultable: 'could not resolve a git revision to verify against', set: null };
  }
  const revision = describedCommit;
  // `revision` is spread LAST so an injected io cannot silently unpin the
  // snapshot every read in this run is supposed to share.
  const readIo = { ...io, revision };
  const { issues, unconsultable, truncated } = io.fetchIssues ? io.fetchIssues() : fetchIssues(io);
  if (unconsultable) {
    // An unconsultable fetch is not an empty backlog. Returning a normal-looking
    // set with zero issues would claim a clean backlog that was never read.
    return { ok: false, unconsultable, set: null };
  }

  let referenceBudget = MAX_TOTAL_REFERENCES;
  let budgetExhausted = false;

  const rows = issues.map((issue) => {
    const classified = classifyIssue(issue);
    // Compared against the issue's OWN count, not merely "is the budget already
    // spent". Checking afterwards lets an issue straddling the ceiling process
    // all of its citations and drive the counter negative while the run still
    // reports itself complete — an overrun the operator-visible budget denies.
    const wanted = classified.references.length;
    if (wanted > 0 && wanted > referenceBudget) {
      budgetExhausted = true;
      classified.references = [];
      classified.referencesTruncated = true;
    } else {
      referenceBudget -= wanted;
    }
    const paths = classified.references.map((r) => r.path);
    const hash = contentHash(paths, readIo);
    const key = { number: issue.number, updatedAt: issue.updatedAt, contentHash: hash };

    const hit = cache ? cacheGet(cache, key) : null;
    const verified = hit
      ? { number: issue.number, route: hit.route, verdict: hit.verdict, evidence: hit.evidence ?? null }
      : verifyIssue(classified, readIo);
    if (cache && !hit) cachePut(cache, key, { route: verified.route, verdict: verified.verdict, evidence: verified.evidence });

    return { ...issue, classified, verified, contentHash: hash, cached: Boolean(hit) };
  });

  const { clusters, unclustered } = clusterIssues(rows, profile.units);
  const sizeOfUnit = new Map(clusters.map((c) => [c.unit, c.issues.length]));

  for (const row of rows) {
    const units = unitsForIssue(row.verified, row.classified, profile.units);
    const frozen = (row.classified.references ?? []).some((r) =>
      (profile.frozenPaths ?? []).some((g) => globMatch(g, r.path))
    );
    row.units = units;
    row.frozen = frozen;
    row.rank = rankIssue({
      verdict: row.verified.verdict,
      labels: row.labels,
      priorityMap: profile.labels.priority,
      clusterSize: units.length ? (sizeOfUnit.get(units[0]) ?? 1) : 1,
      frozen,
    });
  }

  const { pairs, stats } = candidatePairs(rows, { threshold: relationThreshold });
  const { relations, refused } = emitRelations(pairs, judge);

  const proposals = relabelProposals(rows, profile);

  const set = emitGroomedSet({
    generatedFor: describedCommit,
    coverage: { ...coverageOf(rows, { truncated }), budgetExhausted },
    truncated,
    rows,
    clusters,
    unclustered,
    relations,
    relationFilter: { ...stats, refused: refused.length },
    proposals,
  });
  return { ok: true, unconsultable: null, set, rows };
}
