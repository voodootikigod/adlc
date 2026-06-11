// Routing logic for lesson-foundry — pure functions.
// Given a cluster of findings, decide the cheapest permanent defense.

// Categories that route to SKILL
const SKILL_CATEGORIES = new Set(['convention', 'pattern', 'architecture', 'style']);

// Regex to detect quoted literals or recognizable marker patterns in desc/evidence
// Matches "quoted text", 'quoted text', `backtick text`, or common code patterns
const QUOTED_RE = /["'`][^"'`]{1,80}["'`]/;
// Recognizable marker patterns: TODO, FIXME, #noqa, eslint-disable, etc.
const MARKER_RE = /\b(todo|fixme|hack|noqa|eslint-disable|@ts-ignore|suppress|eslint-enable)\b/i;

/**
 * Determine whether a cluster should route to LINT.
 * A cluster routes to LINT if any member's desc (or evidence field) contains:
 * - A quoted literal string
 * - A recognizable marker pattern
 *
 * findings: array of finding objects belonging to this cluster.
 */
export function shouldRouteLint(findings) {
  for (const f of findings) {
    const text = (f.desc ?? '') + ' ' + (f.evidence ?? '');
    if (QUOTED_RE.test(text) || MARKER_RE.test(text)) return true;
  }
  return false;
}

/**
 * Determine route for a cluster.
 * Priority: LINT > SKILL > SPEC-GAP
 * Returns 'lint' | 'skill' | 'spec-gap'
 */
export function routeCluster(findings) {
  if (shouldRouteLint(findings)) return 'lint';

  // Check if any finding's category maps to SKILL
  for (const f of findings) {
    const cat = (f.category ?? '').toLowerCase().trim();
    if (SKILL_CATEGORIES.has(cat)) return 'skill';
  }

  return 'spec-gap';
}

/**
 * Generate a slug/name for a cluster from its sample finding.
 * Used as file basename.
 */
export function clusterName(findings) {
  const desc = findings[0]?.desc ?? 'unnamed';
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'cluster';
}

/**
 * Extract the most prominent quoted literal or marker keyword from findings
 * (for lint pattern generation).
 * Priority: quoted literal > marker keyword > null
 */
export function extractLiteralPattern(findings) {
  // First try quoted literals
  for (const f of findings) {
    const text = (f.desc ?? '') + ' ' + (f.evidence ?? '');
    const match = text.match(/["'`]([^"'`]{1,80})["'`]/);
    if (match) return match[1];
  }
  // Fallback: extract recognizable marker keyword
  for (const f of findings) {
    const text = (f.desc ?? '') + ' ' + (f.evidence ?? '');
    const match = text.match(/\b(TODO|FIXME|HACK|noqa|eslint-disable|@ts-ignore|suppress|eslint-enable)\b/i);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/**
 * Escape a string for use in a regex (grep pattern).
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
