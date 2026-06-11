// lens.mjs — lens file rendering for rejection-mining.
// Pure functions — no I/O.

import { deriveSlug } from './cluster.mjs';

/**
 * Derive a human-readable title from signals or LLM refinement.
 * @param {Array<{body: string}>} signals
 * @param {object|null} llmResult - { title, charter } | null
 * @returns {string}
 */
export function deriveTitle(signals, llmResult = null) {
  if (llmResult?.title) return llmResult.title;
  const slug = deriveSlug(signals);
  // Convert slug to title-case words
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Anonymize an author name for output (first initial + ***).
 * @param {string} author
 * @returns {string}
 */
export function anonymizeAuthor(author) {
  if (!author || author === 'unknown') return 'reviewer';
  const clean = String(author).trim();
  if (clean.length === 0) return 'reviewer';
  return clean.charAt(0).toUpperCase() + '***';
}

/**
 * Truncate a quote to a readable length.
 * @param {string} body
 * @param {number} maxLen
 * @returns {string}
 */
export function truncateQuote(body, maxLen = 200) {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1) + '…';
}

/**
 * Build the lens file content for a cluster.
 *
 * @param {object} opts
 * @param {string} opts.slug
 * @param {string} opts.title
 * @param {string} opts.charter  - charter paragraph (from LLM or derived)
 * @param {Array<{body: string, author: string, prNumber: number}>} opts.signals
 * @param {Set<number>} opts.prNumbers - distinct PR numbers in cluster
 * @returns {string}
 */
export function renderLensFile({ title, charter, signals, prNumbers }) {
  const count = signals.length;
  const prCount = prNumbers.size;

  // Up to 3 anonymized example quotes
  const quotes = signals.slice(0, 3).map((s) => {
    const anon = anonymizeAuthor(s.author);
    const quote = truncateQuote(s.body);
    return `> "${quote}" — ${anon} on PR #${s.prNumber}`;
  });

  const quotesSection = quotes.length > 0
    ? quotes.join('\n\n')
    : '> (no example quotes available)';

  return `# Lens: ${title}

## Charter

When prosecuting a diff, specifically attempt to refute: ${charter}

## Checklist

- [ ] Does this diff trigger the pattern: *${title}*?

## Example Objections

${quotesSection}

---

*mined from ${count} review comment${count === 1 ? '' : 's'} across ${prCount} PR${prCount === 1 ? '' : 's'}*
`;
}

/**
 * Plan lens emissions for a set of clusters.
 *
 * @param {Array<{indices: number[], slug: string}>} clusters
 * @param {Array<{body: string, author: string, prNumber: number}>} signals
 * @param {string} outDir
 * @param {Map<number, {title: string, charter: string}>} llmRefinements
 * @returns {Array<{slug: string, title: string, path: string, content: string, prNumbers: Set, count: number}>}
 */
export function planLensEmissions(clusters, signals, outDir, llmRefinements = new Map()) {
  return clusters.map((cluster, idx) => {
    const clusterSignals = cluster.indices.map((i) => signals[i]);
    const llm = llmRefinements.get(idx) ?? null;

    const title = deriveTitle(clusterSignals, llm);
    const charter = llm?.charter ?? buildDefaultCharter(clusterSignals);
    const prNumbers = new Set(clusterSignals.map((s) => s.prNumber));
    const slug = cluster.slug;

    const content = renderLensFile({ slug, title, charter, signals: clusterSignals, prNumbers });
    const path = `${outDir}/lens-${slug}.md`;

    return {
      slug,
      title,
      path,
      content,
      prNumbers,
      count: clusterSignals.length,
    };
  });
}

/**
 * Build a default charter paragraph from signals.
 * @param {Array<{body: string}>} signals
 * @returns {string}
 */
export function buildDefaultCharter(signals) {
  if (signals.length === 0) return 'this pattern of reviewer objection.';

  // Use first signal body, truncated, as the basis
  const sample = truncateQuote(signals[0].body, 150);
  return `the pattern exemplified by: "${sample}"`;
}
