// walk.mjs — Enumerate source files and build import graph for hot-score.
// Pure functions, no side effects outside filesystem reads.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Source file extensions we care about
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set(['.mjs', '.js', '.ts', '.tsx', '.py']);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__']);

// ---------------------------------------------------------------------------
// Exclusion predicates
// ---------------------------------------------------------------------------

/**
 * Returns true if the file path looks like a test or spec file.
 * Matches patterns like:
 *   - *.test.js, *.spec.ts, *.test.mjs
 *   - files inside __tests__/ or test/ or spec/ directories
 */
export function isTestFile(filePath) {
  const base = filePath.replace(/\\/g, '/');
  if (/\.(test|spec)\.[a-z]+$/.test(base)) return true;
  if (/\/(test|tests|spec|specs|__tests__)\//.test(base)) return true;
  // Also top-level test/ directory (relative paths starting with test/)
  if (/^(test|tests|spec|specs|__tests__)\//.test(base)) return true;
  return false;
}

/**
 * Returns true if the file should be excluded from consideration
 * (non-source: md, json, lock files, test files).
 */
export function isExcluded(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (!SOURCE_EXTS.has(ext)) return true;
  if (isTestFile(filePath)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

/**
 * Walk `root` recursively. Returns all paths (relative to root) that are
 * source files (SOURCE_EXTS), skipping SKIP_DIRS and test/spec files.
 */
export function walkSourceFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const rel = relative(root, full);
        if (!isExcluded(rel)) {
          results.push(rel);
        }
      }
    }
  }
  walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// Import extractor
// ---------------------------------------------------------------------------

// Patterns to extract specifiers from source files.
/**
 * Extract all import/require specifiers from a file's content.
 * Returns an array of specifier strings (may include relative and absolute).
 */
export function extractSpecifiers(content) {
  const specifiers = [];
  const text = content.toString();
  // ES static imports: import ... from 'spec'
  const staticRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  // Dynamic imports: import('spec')
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // require: require('spec')
  const requireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Python from ... import: from specifier import  (relative: from .x import)
  const pyFromRe = /^\s*from\s+(\.[\w./]+)\s+import/gm;

  for (const re of [staticRe, dynamicRe, requireRe, pyFromRe]) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      specifiers.push(m[1]);
    }
  }
  return specifiers;
}

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve a relative specifier from `fromFile` to a repo-relative
 * path. Returns the resolved relative path (with extension) or null if it
 * cannot be resolved to an existing source file.
 *
 * @param {string} specifier  - e.g. './utils' or '../lib/helper'
 * @param {string} fromFile   - repo-relative path of the importing file
 * @param {string} root       - absolute repo root
 * @param {Set<string>} fileSet - set of known repo-relative source file paths
 */
export function resolveSpecifier(specifier, fromFile, root, fileSet) {
  if (!specifier.startsWith('.')) return null; // skip package imports

  const fromDir = dirname(join(root, fromFile));
  const absBase = resolve(fromDir, specifier);
  const relBase = relative(root, absBase);

  // Try exact path first, then with each extension appended.
  const candidates = [relBase];
  for (const ext of SOURCE_EXTS) {
    candidates.push(relBase + ext);
    // Also try index files: relBase/index.ext
    candidates.push(join(relBase, 'index' + ext));
  }

  for (const c of candidates) {
    // Normalize separators for cross-platform safety
    const norm = c.replace(/\\/g, '/');
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

// ---------------------------------------------------------------------------
// In-degree computation
// ---------------------------------------------------------------------------

/**
 * Build an in-degree map: for each file, count how many other source files
 * have an import/require that resolves to it.
 *
 * @param {string[]} files  - repo-relative source file paths
 * @param {string}   root   - absolute repo root
 * @returns {Object.<string, number>} file → inDegree count
 */
export function computeInDegree(files, root) {
  const fileSet = new Set(files.map(f => f.replace(/\\/g, '/')));
  const inDegree = {};
  for (const f of files) inDegree[f.replace(/\\/g, '/')] = 0;

  for (const fromFile of files) {
    let content;
    try {
      content = readFileSync(join(root, fromFile), 'utf8');
    } catch {
      continue;
    }
    const specifiers = extractSpecifiers(content);
    for (const spec of specifiers) {
      const resolved = resolveSpecifier(spec, fromFile, root, fileSet);
      if (resolved && resolved !== fromFile.replace(/\\/g, '/')) {
        inDegree[resolved] = (inDegree[resolved] ?? 0) + 1;
      }
    }
  }
  return inDegree;
}
