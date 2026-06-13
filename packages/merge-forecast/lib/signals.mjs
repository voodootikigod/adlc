/**
 * Conflict signals for a ticket pair (a, b).
 *
 * Combined score = max(individual signal scores).
 * 1.0 = hard veto (scope overlap)
 * 0.8 = namespace collision (route segment or migration prefix)
 * 0.6 = import radius intersection
 * 0.5 = co-change coupling
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { scopesOverlap, globMatch, pairKey } from '@adlc/core';

// ─── Signal 1: Declared scope overlap ────────────────────────────────────────

/**
 * Returns 1.0 if the two tickets' declared scopes overlap (hard veto),
 * else 0.
 */
export function signalScopeOverlap(a, b) {
  return scopesOverlap(a, b) ? 1.0 : 0;
}

// ─── File-tree walker ─────────────────────────────────────────────────────────

/**
 * Walk a directory tree and return all file paths relative to root,
 * skipping node_modules and .git.
 */
export function walkTree(root) {
  const results = [];
  const skipDirs = new Set(['node_modules', '.git']);
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (skipDirs.has(ent.name)) continue;
      const fullPath = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(fullPath);
      } else if (ent.isFile()) {
        // Return path relative to root
        results.push(fullPath.slice(root.length + 1));
      }
    }
  }
  walk(root);
  return results;
}

// ─── Signal 2: Import-radius overlap ─────────────────────────────────────────

const IMPORT_RE = /(?:import|require|from)\s+['"]([^'"]+)['"]/g;

/**
 * Collect all import/require/from specifiers from a file.
 */
function extractImports(filePath) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const specifiers = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  const re = new RegExp(IMPORT_RE.source, 'g');
  while ((m = re.exec(content)) !== null) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

/**
 * Resolve a specifier relative to the importing file.
 * Returns normalized path (without leading ./) or null for non-relative.
 */
function resolveSpecifier(specifier, importingFile, root) {
  if (!specifier.startsWith('.')) return null; // package specifier — ignore
  const importingDir = dirname(join(root, importingFile));
  const resolved = resolve(importingDir, specifier);
  // Make relative to root
  const rel = resolved.startsWith(root + '/') ? resolved.slice(root.length + 1) : null;
  return rel;
}

/**
 * For all files in the repo matching ticket a's scope globs, scan their
 * imports and resolve them. Return a Set of resolved paths that match
 * ticket b's scope.
 */
function importRadiusIntersects(a, b, repoFiles, root) {
  const aFiles = repoFiles.filter((f) =>
    (a.scope ?? []).some((g) => globMatch(g, f))
  );
  const bScope = b.scope ?? [];
  for (const af of aFiles) {
    const specifiers = extractImports(join(root, af));
    for (const spec of specifiers) {
      const resolved = resolveSpecifier(spec, af, root);
      if (resolved === null) continue;
      // Also try with extensions
      const candidates = [
        resolved,
        resolved + '.js',
        resolved + '.mjs',
        resolved + '.ts',
        resolved + '/index.js',
        resolved + '/index.mjs',
        resolved + '/index.ts',
      ];
      for (const candidate of candidates) {
        if (bScope.some((g) => globMatch(g, candidate))) return true;
      }
    }
  }
  return false;
}

/**
 * Returns 0.6 if A's scope files import into B's scope or B's scope files
 * import into A's scope. Returns 0 otherwise.
 */
export function signalImportRadius(a, b, repoFiles, root) {
  if (importRadiusIntersects(a, b, repoFiles, root)) return 0.6;
  if (importRadiusIntersects(b, a, repoFiles, root)) return 0.6;
  return 0;
}

// ─── Signal 3: Co-change coupling ─────────────────────────────────────────────

/**
 * Returns co-change signal in [0, 0.5].
 * max over (fileA from A-matched, fileB from B-matched) of
 * pairCounts[pairKey] / Math.min(fileCounts[fileA], fileCounts[fileB]) × 0.5
 */
export function signalCoChange(a, b, coChangeData, repoFiles) {
  if (!coChangeData) return 0;
  const { pairCounts, fileCounts } = coChangeData;
  const aFiles = repoFiles.filter((f) => (a.scope ?? []).some((g) => globMatch(g, f)));
  const bFiles = repoFiles.filter((f) => (b.scope ?? []).some((g) => globMatch(g, f)));

  let maxScore = 0;
  for (const fa of aFiles) {
    for (const fb of bFiles) {
      if (fa === fb) continue;
      const key = pairKey(fa, fb);
      const pc = pairCounts[key] ?? 0;
      if (pc === 0) continue;
      const minCount = Math.min(fileCounts[fa] ?? 0, fileCounts[fb] ?? 0);
      if (minCount === 0) continue;
      const score = (pc / minCount) * 0.5;
      if (score > maxScore) maxScore = score;
    }
  }
  return Math.min(0.5, maxScore);
}

// ─── Signal 4: Namespace collisions ──────────────────────────────────────────

/**
 * Extract dynamic route segments from a file path.
 * e.g. "app/votes/[pk]/page.tsx" → [{ depth: 2, segment: "pk", path: "app/votes/[pk]" }]
 */
function extractDynamicSegments(filePath) {
  const parts = filePath.split('/');
  const result = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^\[(.+)\]$/);
    if (m) {
      result.push({
        depth: i,
        segment: m[1],
        parentPath: parts.slice(0, i).join('/'),
        fullSegmentPath: parts.slice(0, i + 1).join('/'),
      });
    }
  }
  return result;
}

/**
 * Detect namespace collision from dynamic route segments:
 * A and B each have a bracket segment at the same path depth but different names.
 */
export function signalNamespaceRoutes(a, b, repoFiles) {
  const routeDirs = ['app', 'pages'];
  // Collect dynamic segments from A's matched files (only under app/ or pages/)
  function routeSegments(ticket) {
    const matchedFiles = repoFiles.filter((f) =>
      (ticket.scope ?? []).some((g) => globMatch(g, f))
    );
    const segs = [];
    for (const f of matchedFiles) {
      if (!routeDirs.some((d) => f.startsWith(d + '/'))) continue;
      for (const s of extractDynamicSegments(f)) {
        segs.push(s);
      }
    }
    return segs;
  }

  const aSegs = routeSegments(a);
  const bSegs = routeSegments(b);

  for (const as of aSegs) {
    for (const bs of bSegs) {
      if (as.parentPath === bs.parentPath && as.segment !== bs.segment) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect migration prefix collisions:
 * Files like drizzle/0005_* or migrations/0005_* with same numeric prefix
 * across A and B scopes.
 */
export function signalMigrationCollision(a, b, repoFiles) {
  const migPrefixRe = /(?:^|\/)(?:drizzle|migrations)\/(\d+)_/;

  function migPrefixes(ticket) {
    const matchedFiles = repoFiles.filter((f) =>
      (ticket.scope ?? []).some((g) => globMatch(g, f))
    );
    const prefixes = new Set();
    for (const f of matchedFiles) {
      const m = f.match(migPrefixRe);
      if (m) prefixes.add(m[1]);
    }
    return prefixes;
  }

  const aP = migPrefixes(a);
  const bP = migPrefixes(b);
  for (const p of aP) {
    if (bP.has(p)) return true;
  }
  return false;
}

/**
 * Combined namespace signal: 0.8 if any namespace collision detected, else 0.
 */
export function signalNamespace(a, b, repoFiles) {
  if (signalNamespaceRoutes(a, b, repoFiles)) return 0.8;
  if (signalMigrationCollision(a, b, repoFiles)) return 0.8;
  return 0;
}

// ─── Combined score ───────────────────────────────────────────────────────────

/**
 * Compute conflict score for a pair plus the dominant signal label.
 * Returns { score, signal, hardVeto }.
 */
export function pairScore(a, b, opts = {}) {
  const { repoFiles = [], root = process.cwd(), coChangeData = null } = opts;

  const s1 = signalScopeOverlap(a, b);
  if (s1 >= 1.0) return { score: 1.0, signal: 'scope-overlap', hardVeto: true };

  const s4 = signalNamespace(a, b, repoFiles);
  const s2 = signalImportRadius(a, b, repoFiles, root);
  const s3 = signalCoChange(a, b, coChangeData, repoFiles);

  const score = Math.max(s2, s3, s4);
  let signal = 'none';
  if (score === s4 && s4 > 0) signal = 'namespace-collision';
  else if (score === s2 && s2 > 0) signal = 'import-radius';
  else if (score === s3 && s3 > 0) signal = 'co-change';

  return { score, signal, hardVeto: false };
}
