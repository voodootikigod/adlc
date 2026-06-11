// cluster.mjs — clustering logic for rejection-mining.
// Review prose is wordier than code findings, so threshold is 0.4 (vs 0.5).
// Pure functions — no I/O.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'not', 'no', 'nor',
  'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any',
  'few', 'more', 'most', 'other', 'some', 'such', 'than', 'too', 'very',
  'just', 'that', 'this', 'it', 'its', 'as', 'if', 'then', 'there', 'when',
  'where', 'which', 'who', 'how', 'what', 'use', 'used', 'using', 'via',
  'also', 'only', 'into', 'up', 'out', 'about', 'after', 'before', 'i',
  'we', 'you', 'they', 'my', 'your', 'our', 'their', 'me', 'us', 'them',
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
 * Token-set Jaccard similarity between two Sets.
 * @param {Set} setA
 * @param {Set} setB
 * @returns {number} 0–1
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

  const parent = signals.map((_, i) => i);

  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }

  function union(x, y) {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent[px] = py;
  }

  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      if (jaccard(tokenSets[i], tokenSets[j]) >= threshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < signals.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  return [...groups.values()].sort((a, b) => a[0] - b[0]);
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
