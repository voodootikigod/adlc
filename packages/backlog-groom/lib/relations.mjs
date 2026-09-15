/**
 * Relations between issues (spec §3.4).
 *
 * Relations are O(n²) — 370 open issues is ~68,000 pairs — so a cheap similarity
 * pass SELECTS candidates and judgment then decides each one. The distinction is
 * load-bearing: **similarity is a filter, never evidence.** An emitted relation
 * cites reasoning, and a "reason" that merely restates the score is refused.
 *
 * THE HONEST CONSEQUENCE, reported rather than hidden: the filter's recall is
 * the ceiling on what can ever be found. A pair the filter never surfaces is a
 * relation this tool cannot report.
 *
 * A NOTE ON "MISS RATE" (AC19). A true miss rate needs ground truth — the set of
 * real relations — which this tool does not have and cannot obtain. Reporting a
 * number we cannot compute would be exactly the false precision the rest of the
 * design refuses. What IS knowable, and what the run reports, is how many pairs
 * judgment never saw: `pairsExcluded` and `excludedRate`. That bounds what could
 * have been found, which is the operator-facing meaning of the criterion.
 */

/** The relation kinds the intent's worked example requires staying distinct. */
export const RELATION_KINDS = Object.freeze(['duplicate-of', 'related-to', 'superseded-by']);

/**
 * Cap on tokens considered per issue.
 *
 * Bodies are deliberately uncapped at fetch (a truncated body drops citations),
 * but relation filtering is O(n²) and a handful of issues carrying pasted logs
 * would otherwise dominate the whole sweep. Similarity is a coarse FILTER, so
 * the first N distinct content tokens are ample for it; the full body is still
 * what verification and judgment see.
 */
export const MAX_TOKENS_PER_ISSUE = 400; // pinned: see the test for why the value is deliberate

const STOP = new Set(['the', 'a', 'an', 'is', 'in', 'on', 'of', 'to', 'and', 'or', 'for', 'it', 'that', 'this', 'with', 'when', 'not', 'be', 'are', 'was']);

/**
 * Content tokens of an issue: title and body, lowercased, stopwords dropped.
 *
 * Memoised per issue object. `candidatePairs` is O(n²) and bodies are
 * deliberately uncapped, so re-tokenizing inside the comparison made the work
 * O(n² x body size): 500 issues is ~125,000 pairs, and each one rebuilt two
 * token sets from full issue text before the threshold could reject it.
 */
const TOKEN_CACHE = new WeakMap();

export function tokens(issue) {
  if (typeof issue === 'object' && issue !== null) {
    const hit = TOKEN_CACHE.get(issue);
    if (hit) return hit;
  }
  const built = buildTokens(issue);
  if (typeof issue === 'object' && issue !== null) TOKEN_CACHE.set(issue, built);
  return built;
}

function buildTokens(issue) {
  const out = new Set();
  for (const t of `${issue.title ?? ''} ${issue.body ?? ''}`.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length <= 2 || STOP.has(t)) continue;
    out.add(t);
    if (out.size >= MAX_TOKENS_PER_ISSUE) break;
  }
  return out;
}

/** Jaccard overlap of two token sets — the cheap filter, never the evidence. */
export function similarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Select candidate pairs above `threshold`.
 *
 * @returns {{pairs: object[], stats: object}} stats carries the threshold and
 *   what the filter excluded, so a thin run cannot read as an exhaustive one.
 */
export function candidatePairs(issues, { threshold = 0.2 } = {}) {
  const list = issues ?? [];
  const pairs = [];
  let pairsTotal = 0;
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      pairsTotal += 1;
      const score = similarity(list[i], list[j]);
      if (score >= threshold) pairs.push({ a: list[i], b: list[j], score });
    }
  }
  const pairsExcluded = pairsTotal - pairs.length;
  return {
    pairs,
    stats: {
      threshold,
      pairsTotal,
      pairsSurfaced: pairs.length,
      pairsExcluded,
      // Nothing to exclude is not the same as excluding everything.
      excludedRate: pairsTotal === 0 ? 0 : pairsExcluded / pairsTotal,
    },
  };
}

/**
 * True when `evidence` says something beyond the similarity score.
 *
 * The refusal matters: a judge that echoes "similarity 0.42" has not made a
 * judgment, and accepting it would turn the filter back into the evidence the
 * spec forbids.
 */
function isRealEvidence(evidence) {
  if (typeof evidence !== 'string') return false;
  const text = evidence.trim();
  if (text.length < 12) return false;
  const withoutScore = text.replace(/similarity/gi, '').replace(/[\d.]+/g, '').replace(/[^a-z]/gi, '');
  return withoutScore.length >= 10;
}

/**
 * Ask `judge` about each candidate and emit only confirmed relations.
 *
 * `judge(a, b, score)` returns `{kind, evidence}` or a falsy value to decline.
 * Declining is normal and emits nothing — the filter surfacing a pair is not an
 * argument that the pair is related.
 *
 * @returns {{relations: object[], refused: object[]}} refusals are reported so a
 *   judge that keeps returning unusable answers is visible rather than silent.
 */
export function emitRelations(pairs, judge) {
  const relations = [];
  const refused = [];
  if (typeof judge !== 'function') return { relations, refused };

  for (const p of pairs ?? []) {
    let verdict;
    try {
      verdict = judge(p.a, p.b, p.score);
    } catch (err) {
      refused.push({ from: p.a.number, to: p.b.number, why: `judge threw: ${err.message}` });
      continue;
    }
    if (!verdict) continue;
    if (!RELATION_KINDS.includes(verdict.kind)) {
      refused.push({ from: p.a.number, to: p.b.number, why: `unknown relation kind ${JSON.stringify(verdict.kind)}` });
      continue;
    }
    if (!isRealEvidence(verdict.evidence)) {
      refused.push({ from: p.a.number, to: p.b.number, why: 'evidence absent or merely restates the similarity score' });
      continue;
    }
    relations.push({ from: p.a.number, to: p.b.number, kind: verdict.kind, evidence: verdict.evidence.trim() });
  }
  return { relations, refused };
}
