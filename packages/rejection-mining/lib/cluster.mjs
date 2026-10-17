// cluster.mjs — clustering logic for rejection-mining.
// Review prose is wordier than code findings, so threshold is 0.4 (vs 0.5).
// Pure functions — no I/O.

import { BASE_STOPWORDS, jaccard, clusterByTokenSets } from '@adlc/core';

export { jaccard };

const STOPWORDS = new Set([
  ...BASE_STOPWORDS,
  'i', 'we', 'you', 'they', 'my', 'your', 'our', 'their', 'me', 'us', 'them',
  'please', 'think', 'seems', 'looks', 'feel', 'feels', 'here', 'like',
  'get', 'got', 'getting', 'see', 'seen', 'make', 'makes', 'made',
]);

/**
 * Normalize a review body for clustering:
 * 1. Lowercase
 * 2. Strip URLs
 * 3. Strip quoted code blocks (backtick literals)
 * 4. Strip quoted strings
 * 5. Strip digits
 * 6. Strip punctuation except word boundaries
 * 7. Drop stopwords and very short tokens
 * Returns a Set of tokens.
 *
 * @param {string} body
 * @returns {Set<string>}
 */
export function normalizeBody(body) {
  let s = String(body).toLowerCase();

  // Strip URLs
  s = s.replace(/https?:\/\/[^\s]*/g, ' ');

  // Strip code blocks (triple backtick)
  s = s.replace(/```[\s\S]*?```/g, ' ');

  // Strip inline code (single backtick)
  s = s.replace(/`[^`]*`/g, ' ');

  // Strip quoted strings
  s = s.replace(/"[^"]*"/g, ' ');
  s = s.replace(/'[^']*'/g, ' ');

  // Strip file paths
  s = s.replace(/[^\s]*[/\\][^\s]*/g, ' ');

  // Strip digits
  s = s.replace(/\b\d+\b/g, ' ');

  // Strip punctuation (keep alphanumeric and spaces)
  s = s.replace(/[^a-z0-9\s]/g, ' ');

  // Tokenize, drop stopwords and short tokens (len <= 2)
  const tokens = s.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));

  return new Set(tokens);
}

/**
 * Greedy union-find clustering for review signals.
 * threshold: 0.4 (review prose is wordier — lower threshold for grouping)
 *
 * @param {Array<{body: string}>} signals
 * @param {number} threshold - default 0.4
 * @returns {Array<number[]>} array of clusters (each is array of indices)
 */
export function clusterSignals(signals, threshold = 0.4) {
  if (signals.length === 0) return [];

  const tokenSets = signals.map((s) => normalizeBody(s.body ?? ''));
  return clusterByTokenSets(tokenSets, threshold);
}

/**
 * Derive a slug from representative body text of a cluster.
 * @param {Array<{body: string}>} signals
 * @returns {string}
 */
export function deriveSlug(signals) {
  if (signals.length === 0) return 'unknown';
  const tokens = [...normalizeBody(signals[0].body ?? '')];
  if (tokens.length === 0) return 'cluster';
  // Take up to 4 most meaningful tokens (preserve order from set iteration)
  return tokens.slice(0, 4).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');
}
