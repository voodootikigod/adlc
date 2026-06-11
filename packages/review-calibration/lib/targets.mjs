// review-calibration/lib/targets.mjs
// Selects code files from a commit and builds plant candidates.
// Files changed by the target commit, filtered to non-test/non-meta code only.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Paths that are not source code — excluded from plant targets. */
const EXCLUDE_PATH_RE = /(?:test|spec)/i;
const EXCLUDE_EXT_RE = /\.(?:md|json|yml|yaml|lock|txt|toml|snap|css|svg|png|jpg|gif)$/i;

/**
 * Parse the output of `git show --name-only <commit>` and return the file
 * paths that were changed (the first line is the commit subject; file paths
 * appear after the empty line following the commit message).
 *
 * @param {string} showOutput - stdout from `git show --name-only <commit>`
 * @returns {string[]} array of relative file paths
 */
export function parseCommitFiles(showOutput) {
  const lines = showOutput.split('\n');
  // Skip header lines until we find the first blank line separating the
  // commit message from the diff metadata, then collect non-empty lines.
  let pastHeader = false;
  const files = [];
  for (const line of lines) {
    if (!pastHeader) {
      if (line.trim() === '') pastHeader = true;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed !== '') files.push(trimmed);
  }
  return files;
}

/**
 * Filter a list of file paths to those eligible for plant injection.
 * Excludes test/spec files and non-code extensions.
 *
 * @param {string[]} files
 * @returns {string[]}
 */
export function filterCodeFiles(files) {
  return files.filter((f) => {
    if (EXCLUDE_PATH_RE.test(f)) return false;
    if (EXCLUDE_EXT_RE.test(f)) return false;
    return true;
  });
}

/**
 * Read a file safely. Returns null if the file cannot be read.
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

/**
 * Select up to `maxPlants` mutants spread across files AND operators
 * (round-robin by operator for category coverage).
 *
 * Strategy: for each file, generate all possible mutants (full file, no
 * targetLines restriction). Then round-robin by operator name across all
 * candidates until we have maxPlants or run out.
 *
 * Returns an array of plant objects:
 *   { file, absolutePath, line, operator, original, mutated }
 *
 * @param {string[]} codeFiles  - Relative file paths
 * @param {string} cwd          - Repo root
 * @param {number} maxPlants    - Total plants to select
 * @param {Function} generateMutants - mutate.generateMutants
 * @returns {Array<{ file: string, absolutePath: string, line: number, operator: string, original: string, mutated: string }>}
 */
export function selectPlants(codeFiles, cwd, maxPlants, generateMutants) {
  // Gather all candidates per operator across all files.
  /** @type {Map<string, Array<{ file, absolutePath, line, operator, original, mutated }>>} */
  const byOperator = new Map();

  for (const file of codeFiles) {
    const absolutePath = resolve(cwd, file);
    const content = readFileSafe(absolutePath);
    if (content === null) continue;

    // Generate with no targetLines restriction (full file) and a large cap.
    const mutants = generateMutants(content, { maxMutants: 500 });
    for (const m of mutants) {
      const entry = { file, absolutePath, line: m.line, operator: m.operator, original: m.original, mutated: m.mutated };
      if (!byOperator.has(m.operator)) byOperator.set(m.operator, []);
      byOperator.get(m.operator).push(entry);
    }
  }

  if (byOperator.size === 0) return [];

  // Round-robin across operators until we have maxPlants.
  const operatorNames = [...byOperator.keys()];
  const indices = new Map(operatorNames.map((op) => [op, 0]));
  const selected = [];
  let opIdx = 0;

  while (selected.length < maxPlants) {
    let advanced = false;
    // Try each operator in round-robin order until we complete a full cycle
    // without finding any new candidate (all exhausted).
    for (let attempt = 0; attempt < operatorNames.length; attempt++) {
      const op = operatorNames[(opIdx + attempt) % operatorNames.length];
      const pool = byOperator.get(op);
      const idx = indices.get(op);
      if (idx < pool.length) {
        selected.push(pool[idx]);
        indices.set(op, idx + 1);
        opIdx = (opIdx + attempt + 1) % operatorNames.length;
        advanced = true;
        break;
      }
    }
    if (!advanced) break; // All operator pools exhausted.
  }

  return selected;
}
