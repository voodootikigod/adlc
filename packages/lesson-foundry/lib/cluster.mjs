// Clustering logic for lesson-foundry.
// Pure functions — no I/O.

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'not', 'no', 'nor',
  'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any',
  'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
  'just', 'that', 'this', 'it', 'its', 'as', 'if', 'then', 'there', 'when',
  'where', 'which', 'who', 'how', 'what', 'use', 'used', 'using', 'via',
  'also', 'only', 'into', 'up', 'out', 'about', 'after', 'before',
]);

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
 * Token-set Jaccard similarity between two Sets.
 * Returns 0 for empty inputs.
 */
export function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
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
  // Pre-compute normalized token sets
  const tokenSets = findings.map((f) => normalizeDesc(f.desc ?? ''));

  // Union-Find
  const parent = findings.map((_, i) => i);

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(x, y) {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent[px] = py;
  }

  // For each pair (i < j), merge if jaccard >= threshold
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) {
        union(i, j);
      }
    }
  }

  // Collect clusters keyed by root
  const groups = new Map();
  for (let i = 0; i < findings.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  // Return as array sorted by first index in each group (preserves order)
  return [...groups.values()].sort((a, b) => a[0] - b[0]);
}
