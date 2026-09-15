/**
 * Fetch the open backlog (spec §3.1).
 *
 * THE TRUNCATION RULE, inherited from `scripts/release-audit-collect.mjs`
 * `fetchIssues` and repeated here because it is load-bearing: a response of
 * exactly the limit is reported as `truncated`, never accepted as complete. A
 * capped list is indistinguishable from a complete one, and silently dropping
 * the tail would let a sweep report "nothing to groom" about issues it never
 * saw — the same false-green this package exists to detect.
 *
 * TWO DELIBERATE DEPARTURES from that function, which is a rail and cannot be
 * edited:
 *  - `updatedAt` is requested. The cache key (§4) is `(updatedAt, contentHash)`,
 *    so without it the cache cannot tell a changed issue from an unchanged one.
 *  - Bodies are NOT capped. release-audit truncates to 4000 chars because it
 *    only needs path mentions for routing; this package parses the body for code
 *    references and fenced snippets, and a cut body would drop a reference and
 *    quietly demote a mechanically-verifiable issue to the model route.
 */

import { execFileSync } from 'node:child_process';

/** How many open issues a single fetch will ask for. */
export const ISSUE_FETCH_LIMIT = 500;

/** The `gh --json` field set. `updatedAt` is required by the cache key. */
export const ISSUE_FIELDS = 'number,title,body,labels,url,updatedAt';

/**
 * Run a command, returning `{ok, out}` rather than throwing, so a `gh` failure
 * becomes an explicit `unconsultable` record instead of an exception that a
 * caller might mistake for an empty backlog.
 */
function tryRun(cmd, args, run) {
  try {
    return { ok: true, out: String(run(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).trim() };
  } catch (err) {
    const out = [err?.stderr, err?.stdout, err?.message].filter(Boolean).map(String).join(' ').trim();
    return { ok: false, out };
  }
}

/**
 * Open GitHub issues, or an explicit unconsultable record when `gh` cannot
 * answer.
 *
 * Never returns an empty `issues` array as a SUCCESS when the fetch failed: a
 * sweep that reports "0 issues" for a `gh` error would claim a clean backlog it
 * never read.
 *
 * @param {object} [o]
 * @param {Function} [o.run] - injected command runner (execFileSync shape)
 * @param {number} [o.limit] - override the fetch limit (tests)
 * @returns {{issues: object[], unconsultable: string|null, truncated: number|null}}
 */
export function fetchIssues({ run = execFileSync, limit = ISSUE_FETCH_LIMIT } = {}) {
  const r = tryRun('gh', ['issue', 'list', '--state', 'open', '--limit', String(limit), '--json', ISSUE_FIELDS], run);
  if (!r.ok) return { issues: [], unconsultable: `gh issue list failed: ${r.out.slice(0, 400)}`, truncated: null };

  let parsed;
  try {
    parsed = JSON.parse(r.out);
  } catch (err) {
    return { issues: [], unconsultable: `gh issue list returned unparseable JSON: ${err.message}`, truncated: null };
  }
  if (!Array.isArray(parsed)) {
    return { issues: [], unconsultable: `gh issue list returned unparseable JSON: expected an array, got ${typeof parsed}`, truncated: null };
  }

  return {
    issues: parsed.map((i) => ({
      number: i.number,
      title: String(i.title ?? ''),
      body: String(i.body ?? ''),
      labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean),
      url: i.url ?? null,
      updatedAt: i.updatedAt ?? null,
    })),
    unconsultable: null,
    // `>=`, not `===`: treating "more than we asked for" as a complete answer
    // would be the same blind spot the rule exists to close.
    truncated: parsed.length >= limit ? limit : null,
  };
}
