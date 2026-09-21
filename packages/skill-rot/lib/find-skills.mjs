/**
 * find-skills.mjs — recursively find SKILL.md files under given roots,
 * skipping node_modules and .git directories.
 */

import { readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

/** Default search roots (only those that exist are searched). */
export const DEFAULT_ROOTS = ['.claude/skills', '.agents/skills', 'skills'];

/**
 * Find all SKILL.md files under the given root directories.
 * @param {string[]} roots - directories to search (relative to repoRoot or absolute)
 * @param {string} repoRoot - absolute path to the repo root
 * @param {object} [opts]
 * @param {boolean} [opts.strict=false] - if true, throws when a root path does not exist
 * @returns {string[]} absolute paths to SKILL.md files
 */
export function findSkills(roots, repoRoot, { strict = false } = {}) {
  const results = [];
  const visited = new Set();
  for (const root of roots) {
    const absRoot = resolve(repoRoot, root);
    if (!existsSync(absRoot)) {
      if (strict) {
        throw new Error(`path does not exist: ${absRoot}`);
      }
      continue;
    }
    const stat = statSync(absRoot);
    if (stat.isDirectory()) {
      collectSkills(absRoot, results, strict, visited);
    } else if (stat.isFile() && basename(absRoot) === 'SKILL.md') {
      results.push(absRoot);
    } else if (strict) {
      // The caller named this path and it is neither a skills directory nor a
      // SKILL.md (a README.md, say). Skipping it silently is the same false
      // green #768 closes for missing paths.
      throw new Error(`not a skills directory or SKILL.md file: ${absRoot}`);
    }
  }
  return results;
}

/**
 * Recursively walk dir and collect SKILL.md files.
 * Skips node_modules and .git directories. With strict (explicit roots) an
 * unreadable subtree is an error — a clean verdict must mean everything the
 * caller named was inspected; best-effort skipping is for default discovery.
 * `strict` is a required positional: a defaulted option that every caller
 * overrides is dead code the mutation gate rightly flags.
 */
function collectSkills(dir, results, strict, visited) {
  const realDir = realpathSync(dir);
  if (visited.has(realDir)) return;
  visited.add(realDir);

  const realBase = basename(realDir);
  if (realBase === 'node_modules' || realBase === '.git') return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (strict) throw new Error(`cannot read directory ${dir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      collectSkills(fullPath, results, strict, visited);
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      results.push(fullPath);
    } else if (entry.isSymbolicLink()) {
      let targetStat;
      try {
        targetStat = statSync(fullPath);
      } catch (err) {
        if (strict) throw new Error(`broken symlink: ${fullPath} (${err.message})`);
        continue;
      }

      if (targetStat.isDirectory()) {
        collectSkills(fullPath, results, strict, visited);
      } else if (targetStat.isFile() && entry.name === 'SKILL.md') {
        results.push(fullPath);
      }
    }
  }
}
