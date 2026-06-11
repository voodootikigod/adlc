// signal.mjs — negative-signal extraction from PR review bodies.
// Pure functions — no I/O.

/**
 * Regex for negative-signal patterns in review comments.
 * Matches common objection language in PR reviews.
 */
export const NEGATIVE_SIGNAL_RE = /\b(don't|do not|should not|must not|never|avoid|instead|wrong|breaks|missing|remove this|why (is|are|do|does))\b/i;

/**
 * Test whether a text body contains a negative signal.
 * @param {string} body
 * @returns {boolean}
 */
export function hasNegativeSignal(body) {
  if (!body || typeof body !== 'string') return false;
  return NEGATIVE_SIGNAL_RE.test(body);
}

/**
 * Extract all review and comment bodies from a PR detail object.
 * Each item: { body, author, prNumber, source }
 * source: 'review' | 'comment'
 *
 * @param {object} prDetail - { reviews: [], comments: [] }
 * @param {number} prNumber
 * @returns {Array<{body: string, author: string, prNumber: number, source: string}>}
 */
export function extractBodies(prDetail, prNumber) {
  const items = [];

  const reviews = Array.isArray(prDetail?.reviews) ? prDetail.reviews : [];
  for (const r of reviews) {
    const body = (r.body ?? '').trim();
    if (body.length > 0) {
      items.push({
        body,
        author: r.author?.login ?? r.author ?? 'unknown',
        prNumber,
        source: 'review',
      });
    }
  }

  const comments = Array.isArray(prDetail?.comments) ? prDetail.comments : [];
  for (const c of comments) {
    const body = (c.body ?? '').trim();
    if (body.length > 0) {
      items.push({
        body,
        author: c.author?.login ?? c.author ?? 'unknown',
        prNumber,
        source: 'comment',
      });
    }
  }

  return items;
}

/**
 * Filter bodies to only those containing negative signals.
 * @param {Array<{body: string, author: string, prNumber: number, source: string}>} bodies
 * @returns {Array}
 */
export function filterNegativeSignals(bodies) {
  return bodies.filter((item) => hasNegativeSignal(item.body));
}
