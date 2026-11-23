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
import { join, resolve, dirname, win32 } from 'node:path';
import { scopesOverlap, pairKey } from '@adlc/core';
import { createScopeIndex } from './scope-index.mjs';

// ─── Signal 1: Declared scope overlap ────────────────────────────────────────

/**
 * Returns 1.0 if the two tickets' declared scopes overlap (hard veto),
 * either syntactically or on any concrete file in the scope index, else 0.
 */
export function signalScopeOverlap(a, b, index = null) {
  if (scopesOverlap(a, b)) return 1.0;
  if (index) {
    const aFiles = index.files(a.scope);
    const bFiles = index.files(b.scope);
    const aSet = new Set(aFiles);
    for (const f of bFiles) {
      if (aSet.has(f)) return 1.0;
    }
  }
  return 0;
}

// ─── File-tree walker ─────────────────────────────────────────────────────────

/**
 * Walk a directory tree and return all file paths relative to root,
 * skipping node_modules, .git, .worktrees, and .claude.
 */
export function walkTree(root) {
  const results = [];
  const skipDirs = new Set(['node_modules', '.git', '.worktrees', '.claude']);
  function walk(dir, relDir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (skipDirs.has(ent.name)) continue;
      const fullPath = join(dir, ent.name);
      const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(fullPath, relPath);
      } else if (ent.isFile()) {
        results.push(relPath);
      }
    }
  }
  walk(root.replace(/\\/g, '/'), '');
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
export function resolveSpecifier(specifier, importingFile, root) {
  if (!specifier.startsWith('.')) return null; // package specifier — ignore
  const rootRaw = root.replace(/\\/g, '/');
  const isWinDrive = /^[a-zA-Z]:/.test(rootRaw);
  const p = isWinDrive ? win32 : { dirname, join, resolve };
  const rootNorm = p.resolve(rootRaw || '/').replace(/\\/g, '/').replace(/\/+$/, '');
  const importingFileNorm = importingFile.replace(/\\/g, '/');
  const importingDir = p.dirname(p.join(rootNorm || '/', importingFileNorm));
  const resolvedNorm = p.resolve(importingDir, specifier).replace(/\\/g, '/');
  const prefix = rootNorm === '' ? '/' : `${rootNorm}/`;
  return resolvedNorm.startsWith(prefix)
    ? resolvedNorm.slice(prefix.length)
    : null;
}

// Pre-indexed resolved import candidates per (scopeIndex, rootNorm) so each
// repo file is read and parsed at most once across all O(T^2) ticket pairs.
const importCandidatesByIndex = new WeakMap();

function getImportCache(index, rootNorm) {
  let byRoot = importCandidatesByIndex.get(index);
  if (!byRoot) {
    byRoot = new Map();
    importCandidatesByIndex.set(index, byRoot);
  }
  let cache = byRoot.get(rootNorm);
  if (!cache) {
    cache = new Map();
    byRoot.set(rootNorm, cache);
  }
  return cache;
}

function resolvedImportCandidates(afNorm, rootNorm, cache) {
  let candidates = cache.get(afNorm);
  if (candidates !== undefined) return candidates;
  const specifiers = extractImports(join(rootNorm, afNorm));
  candidates = [];
  for (const spec of specifiers) {
    const resolved = resolveSpecifier(spec, afNorm, rootNorm);
    if (resolved === null) continue;
    // Also try with extensions
    candidates.push(
      resolved,
      resolved + '.js',
      resolved + '.mjs',
      resolved + '.ts',
      resolved + '/index.js',
      resolved + '/index.mjs',
      resolved + '/index.ts',
    );
  }
  cache.set(afNorm, candidates);
  return candidates;
}

/**
 * For all files in the repo matching ticket a's scope globs, scan their
 * imports and resolve them. Return true if any resolved candidate matches
 * ticket b's scope.
 */
function importRadiusIntersects(a, b, repoFiles, root, index) {
  const aFiles = index.filesNormalized(a.scope);
  // Resolved once, not per candidate: building it serialises the whole scope.
  const inB = index.matcher(b.scope);
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const cache = getImportCache(index, rootNorm);
  for (const af of aFiles) {
    const afNorm = af.replace(/\\/g, '/');
    const candidates = resolvedImportCandidates(afNorm, rootNorm, cache);
    for (const candidate of candidates) {
      if (inB(candidate)) return true;
    }
  }
  return false;
}

/**
 * Returns 0.6 if A's scope files import into B's scope or B's scope files
 * import into A's scope. Returns 0 otherwise.
 */
export function signalImportRadius(a, b, repoFiles, root, index = createScopeIndex(repoFiles)) {
  if (importRadiusIntersects(a, b, repoFiles, root, index)) return 0.6;
  if (importRadiusIntersects(b, a, repoFiles, root, index)) return 0.6;
  return 0;
}

// ─── Signal 3: Co-change coupling ─────────────────────────────────────────────

/**
 * Returns co-change signal in [0, 0.5].
 * max over (fileA from A-matched, fileB from B-matched) of
 * pairCounts[pairKey] / Math.min(fileCounts[fileA], fileCounts[fileB]) × 0.5
 */
export const MIN_COCHANGE_SUPPORT = 3;

export function signalCoChange(a, b, coChangeData, repoFiles, index = createScopeIndex(repoFiles)) {
  if (!coChangeData) return 0;
  const { pairCounts, fileCounts } = coChangeData;
  const aFiles = index.files(a.scope);
  const bFiles = index.files(b.scope);

  let maxScore = 0;
  for (const fa of aFiles) {
    for (const fb of bFiles) {
      if (fa === fb) continue;
      const key = pairKey(fa, fb);
      const pc = pairCounts[key] ?? 0;
      if (pc < MIN_COCHANGE_SUPPORT) continue;
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
export function signalNamespaceRoutes(a, b, repoFiles, index = createScopeIndex(repoFiles)) {
  const routeDirs = ['app', 'pages'];
  // Collect dynamic segments from A's matched files (only under app/ or pages/)
  function routeSegments(ticket) {
    const matchedFiles = index.files(ticket.scope);
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
export function signalMigrationCollision(a, b, repoFiles, index = createScopeIndex(repoFiles)) {
  const migPrefixRe = /(?:^|\/)(?:drizzle|migrations)\/(\d+)_/;

  function migPrefixes(ticket) {
    const matchedFiles = index.files(ticket.scope);
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
export function signalNamespace(a, b, repoFiles, index = createScopeIndex(repoFiles)) {
  if (signalNamespaceRoutes(a, b, repoFiles, index)) return 0.8;
  if (signalMigrationCollision(a, b, repoFiles, index)) return 0.8;
  return 0;
}

// ─── Signal 5: Semantic Graph Coupling ───────────────────────────────────────

// Pre-indexed CodeGraph edges keyed by the edges array so O(|E|) indexing
// happens once per forecast run instead of scanning all edges for every pair.
const edgeIndexByEdges = new WeakMap();

function addEndpoint(map, key, entry) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(entry);
}

function indexEdges(edges) {
  let cached = edgeIndexByEdges.get(edges);
  if (cached) return cached;

  const scores = [];
  const exactMap = new Map();
  const suffixMap = new Map();

  for (const edge of edges) {
    const src = edge.from ?? edge.source ?? edge.callerFile ?? edge.fromFile;
    const dst = edge.to ?? edge.target ?? edge.calleeFile ?? edge.toFile;
    if (!src || !dst) continue;
    const id = scores.length;
    const weight = typeof edge.weight === 'number' ? Math.min(1.0, edge.weight) : 1.0;
    scores.push(weight * 0.7);

    const srcEntry = [id, 1];
    const dstEntry = [id, 2];
    addEndpoint(exactMap, src, srcEntry);
    addEndpoint(exactMap, dst, dstEntry);
    addEndpoint(suffixMap, src, srcEntry);
    addEndpoint(suffixMap, dst, dstEntry);

    let pos = src.indexOf('/');
    while (pos !== -1) {
      const suf = src.slice(pos + 1);
      if (suf) addEndpoint(suffixMap, suf, srcEntry);
      pos = src.indexOf('/', pos + 1);
    }
    pos = dst.indexOf('/');
    while (pos !== -1) {
      const suf = dst.slice(pos + 1);
      if (suf) addEndpoint(suffixMap, suf, dstEntry);
      pos = dst.indexOf('/', pos + 1);
    }
  }

  const matchesByFiles = new WeakMap();

  function matchFiles(files) {
    let matched = matchesByFiles.get(files);
    if (matched) return matched;
    matched = new Map();
    for (const f of files) {
      const hit1 = suffixMap.get(f);
      if (hit1) {
        for (const [id, bit] of hit1) {
          matched.set(id, (matched.get(id) ?? 0) | bit);
        }
      }
      let pos = f.indexOf('/');
      while (pos !== -1) {
        const suf = f.slice(pos + 1);
        if (suf) {
          const hit2 = exactMap.get(suf);
          if (hit2) {
            for (const [id, bit] of hit2) {
              matched.set(id, (matched.get(id) ?? 0) | bit);
            }
          }
        }
        pos = f.indexOf('/', pos + 1);
      }
    }
    matchesByFiles.set(files, matched);
    return matched;
  }

  cached = { scores, matchFiles };
  edgeIndexByEdges.set(edges, cached);
  return cached;
}

/**
 * Returns graph coupling signal in [0, 0.7].
 * Detects semantic cross-ticket dependencies via pre-computed symbol/call graph
 * (e.g. Spanner Graph, mcp__spannercg, or graph coupling export).
 */
export function signalGraphCoupling(a, b, graphCouplingData, repoFiles, index = createScopeIndex(repoFiles)) {
  if (!graphCouplingData) return 0;
  const aFiles = index.files(a.scope);
  const bFiles = index.files(b.scope);

  // 1. Direct fileCoupling map: { "fileA|fileB": score }
  if (graphCouplingData.fileCoupling && typeof graphCouplingData.fileCoupling === 'object') {
    let maxCoupling = 0;
    for (const fa of aFiles) {
      for (const fb of bFiles) {
        if (fa === fb) continue;
        const s1 = graphCouplingData.fileCoupling[`${fa}|${fb}`] ?? graphCouplingData.fileCoupling[pairKey(fa, fb)];
        const s2 = graphCouplingData.fileCoupling[`${fb}|${fa}`];
        const val = Math.max(s1 ?? 0, s2 ?? 0);
        if (val > maxCoupling) maxCoupling = val;
      }
    }
    if (maxCoupling > 0) return Math.min(0.7, maxCoupling > 1 ? 0.7 : maxCoupling * 0.7);
  }

  // 2. Edges array: [{ from, to, weight? }] or [{ source, target, weight? }]
  const edges = Array.isArray(graphCouplingData.edges)
    ? graphCouplingData.edges
    : Array.isArray(graphCouplingData.links)
    ? graphCouplingData.links
    : Array.isArray(graphCouplingData)
    ? graphCouplingData
    : null;

  if (edges) {
    const { scores, matchFiles } = indexEdges(edges);
    const aMatches = matchFiles(aFiles);
    const bMatches = matchFiles(bFiles);
    let maxCoupling = 0;
    for (const [id, maskA] of aMatches) {
      const maskB = bMatches.get(id);
      if (!maskB) continue;
      if (((maskA & 1) && (maskB & 2)) || ((maskA & 2) && (maskB & 1))) {
        const score = scores[id];
        if (score > maxCoupling) maxCoupling = score;
      }
    }
    if (maxCoupling > 0) return maxCoupling;
  }

  return 0;
}

// ─── Combined score ───────────────────────────────────────────────────────────

/**
 * Compute conflict score for a pair plus the dominant signal label.
 * Returns { score, signal, hardVeto }.
 */
export function pairScore(a, b, opts = {}) {
  const {
    repoFiles = [],
    root = process.cwd(),
    coChangeData = null,
    graphCouplingData = null,
    // One index per run, shared by every pair (see scope-index.mjs). A caller
    // that scores a single pair may omit it.
    scopeIndex = createScopeIndex(repoFiles),
  } = opts;

  const s1 = signalScopeOverlap(a, b, scopeIndex);
  if (s1 >= 1.0) return { score: 1.0, signal: 'scope-overlap', hardVeto: true };

  const s4 = signalNamespace(a, b, repoFiles, scopeIndex);
  const s5 = signalGraphCoupling(a, b, graphCouplingData, repoFiles, scopeIndex);
  const s2 = signalImportRadius(a, b, repoFiles, root, scopeIndex);
  const s3 = signalCoChange(a, b, coChangeData, repoFiles, scopeIndex);

  const score = Math.max(s2, s3, s4, s5);
  let signal = 'none';
  if (score === s4 && s4 > 0) signal = 'namespace-collision';
  else if (score === s5 && s5 > 0) signal = 'graph-coupling';
  else if (score === s2 && s2 > 0) signal = 'import-radius';
  else if (score === s3 && s3 > 0) signal = 'co-change';

  return { score, signal, hardVeto: false };
}
