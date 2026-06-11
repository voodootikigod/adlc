// hollow-test/lib/targets.mjs
// Filters diff targets, distributing the mutation budget across files.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Patterns to exclude from mutation: test/spec files and non-code files.
const EXCLUDE_PATH_RE = /(?:test|spec)/i;
const EXCLUDE_EXT_RE = /\.(?:md|json|yml|yaml|lock|txt|toml|snap)$/i;

/**
 * Determine which files from the diff should be mutated.
 * Excludes test/spec files and non-code files.
 *
 * @param {{ [file: string]: Set<number> }} changedLines - From mutate.changedLinesFromDiff()
 * @returns {string[]} Array of file paths eligible for mutation.
 */
export function filterTargetFiles(changedLines) {
  return Object.keys(changedLines).filter((f) => {
    if (EXCLUDE_PATH_RE.test(f)) return false;
    if (EXCLUDE_EXT_RE.test(f)) return false;
    return true;
  });
}

/**
 * Distribute a total mutation budget across files in round-robin fashion.
 * Returns an array of { file, targetLines, quota } objects.
 *
 * @param {string[]} files          - Filtered file paths.
 * @param {{ [file: string]: Set<number> }} changedLines
 * @param {number} maxTotal         - Total mutant budget.
 * @param {string} cwd              - Repository root (to resolve relative paths).
 * @returns {Array<{ file: string, absolutePath: string, targetLines: Set<number>, quota: number }>}
 */
export function buildFileTargets(files, changedLines, maxTotal, cwd) {
  if (files.length === 0) return [];
  const base = Math.floor(maxTotal / files.length);
  const remainder = maxTotal % files.length;

  return files.map((file, idx) => ({
    file,
    absolutePath: resolve(cwd, file),
    targetLines: changedLines[file],
    quota: base + (idx < remainder ? 1 : 0),
  }));
}

/**
 * Read file content from disk. Returns null if the file cannot be read.
 *
 * @param {string} absolutePath
 * @returns {string | null}
 */
export function readFileSafe(absolutePath) {
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}
