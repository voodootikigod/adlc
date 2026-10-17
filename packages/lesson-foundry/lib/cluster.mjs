// Clustering logic for lesson-foundry.
// Pure functions — no I/O.

import { BASE_STOPWORDS, jaccard, clusterByTokenSets } from '@adlc/core';

export { jaccard };

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const STOPWORDS = BASE_STOPWORDS;

/**
 * Normalize a description for clustering:
 * 1. Lowercase
 * 2. Strip file paths (unix/windows paths, dot-separated module names with slash)
 * 3. Strip quoted literals (single/double quoted strings)
 * 4. Strip digits (line numbers, counts)
 * 5. Strip punctuation except word boundaries
 * 6. Drop stopwords
 * Returns a Set of tokens.
 */
export function normalizeDesc(desc) {
  let s = String(desc).toLowerCase();

  // Strip quoted literals (single or double quoted strings)
  s = s.replace(/"[^"]*"/g, ' ');
  s = s.replace(/'[^']*'/g, ' ');
  s = s.replace(/`[^`]*`/g, ' ');

  // Strip file paths (sequences with / or \)
  s = s.replace(/[^\s]*[/\\][^\s]*/g, ' ');

  // Strip digits (stand-alone numbers)
  s = s.replace(/\b\d+\b/g, ' ');

  // Strip punctuation (keep alphanumeric and space)
  s = s.replace(/[^a-z0-9\s]/g, ' ');

  // Tokenize, drop stopwords and short tokens
  const tokens = s.split(/\s+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));

  return new Set(tokens);
}

/**
 * Greedy single-pass union-find clustering.
 * findings: array of { desc, ... }
 * threshold: minimum Jaccard to merge (default 0.5)
 *
 * Returns array of clusters, each cluster is an array of finding indices.
 * Order: first cluster contains the first finding encountered.
 */
export function clusterFindings(findings, threshold = 0.5) {
  const tokenSets = findings.map((f) => normalizeDesc(f.desc ?? ''));
  return clusterByTokenSets(tokenSets, threshold);
}
