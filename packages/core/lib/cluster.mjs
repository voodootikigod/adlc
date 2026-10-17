// packages/core/lib/cluster.mjs
// Shared clustering and token-set similarity primitives.

/**
 * Common English stopwords shared across clustering packages.
 * @type {ReadonlySet<string>}
 */
export const BASE_STOPWORDS = Object.freeze(new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'not', 'no', 'nor',
  'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any',
  'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
  'just', 'that', 'this', 'it', 'its', 'as', 'if', 'then', 'there', 'when',
  'where', 'which', 'who', 'how', 'what', 'use', 'used', 'using', 'via',
  'also', 'only', 'into', 'up', 'out', 'about', 'after', 'before',
]));

/**
 * Token-set Jaccard similarity between two Sets.
 *
 * @param {ReadonlySet<unknown>} setA
 * @param {ReadonlySet<unknown>} setB
 * @returns {number} similarity score in range [0, 1]
 */
export function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const item of smaller) {
    if (larger.has(item)) {
      intersection++;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Clusters an array of token sets using single-pass Union-Find with path compression.
 * Merges pair (i, j) whenever jaccard(tokenSets[i], tokenSets[j]) >= threshold.
 *
 * @param {ReadonlyArray<ReadonlySet<string>>} tokenSets
 * @param {number} [threshold=0.5]
 * @returns {number[][]} array of clusters (each cluster is an array of indices sorted ascending)
 */
export function clusterByTokenSets(tokenSets, threshold = 0.5) {
  const n = tokenSets.length;
  if (n === 0) return [];

  const parent = Array.from({ length: n }, (_, i) => i);

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

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let group = groups.get(root);
    if (!group) {
      group = [];
      groups.set(root, group);
    }
    group.push(i);
  }

  const result = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a - b);
    result.push(group);
  }

  return result.sort((a, b) => a[0] - b[0]);
}
