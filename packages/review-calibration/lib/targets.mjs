// review-calibration/lib/targets.mjs
// Selects code files from a commit and builds plant candidates.
// Files changed by the target commit, filtered to non-test/non-meta code only.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Paths that are not source code — excluded from plant targets. */
const EXCLUDE_PATH_RE = /(?:test|spec)/i;
const EXCLUDE_EXT_RE = /\.(?:md|json|jsonl|yml|yaml|lock|txt|toml|snap|css|svg|png|jpg|gif)$/i;

/**
 * Map a mechanical mutation operator to a real bug CATEGORY. Per-category
 * recall (auth-bypass, off-by-one, ...) is what exposes reviewer blind spots;
 * keying the breakdown on the operator name — the mechanical move — could not.
 */
const OPERATOR_CATEGORY = {
  'off-by-one': 'off-by-one',
  'bool-flip': 'logic-inversion',
  'invert-comparison': 'logic-inversion',
  'logic-swap': 'logic-inversion',
  'null-return': 'null-handling',
};

export function operatorToCategory(operator) {
  return OPERATOR_CATEGORY[operator] ?? 'logic';
}

/** A short natural-language defect description the judge compares findings against. */
export function describeDefect(operator, original, mutated) {
  const o = (original ?? '').trim();
  const m = (mutated ?? '').trim();
  const map = {
    'off-by-one': 'Off-by-one error: the boundary or arithmetic was shifted by one.',
    'bool-flip': 'Inverted boolean: a true/false value was flipped, reversing the branch taken.',
    'invert-comparison': 'Inverted comparison: the conditional now matches the opposite case.',
    'logic-swap': 'Swapped logical operator, changing which conditions must hold.',
    'null-return': 'Return value nulled out, dropping the real result.',
  };
  const head = map[operator] ?? 'Logic defect introduced by the change.';
  return `${head} (\`${o}\` -> \`${m}\`)`;
}

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
 * Load plants from an external JSON file (--plants-file). Enables externally
 * authored plants: LLM-generated subtle bugs, hand-written semantic bugs —
 * anything beyond the mechanical mutation operators.
 *
 * File format: JSON array of
 *   { file: string, line: number (1-based), original: string,
 *     mutated: string, category?: string }
 *
 * Each plant is validated against the current working tree: the file must
 * exist and its `line` must exactly equal `original` (same refuse-if-drifted
 * contract as mutate.applyMutant). Returns { plants, errors } — plants in
 * the internal shape { file, absolutePath, line, operator, original, mutated }
 * with operator = category ?? 'custom'.
 *
 * @param {string} plantsPath - path to the JSON file
 * @param {string} cwd        - repo root
 * @returns {{ plants: Array, errors: string[] }}
 */
export function loadPlantsFile(plantsPath, cwd) {
  let raw;
  try {
    raw = readFileSync(plantsPath, 'utf8');
  } catch (err) {
    return { plants: [], errors: [`cannot read plants file: ${err.message}`] };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { plants: [], errors: [`invalid JSON in plants file: ${err.message}`] };
  }
  if (!Array.isArray(data)) {
    return { plants: [], errors: ['plants file must be a JSON array'] };
  }

  const plants = [];
  const errors = [];
  for (const [i, p] of data.entries()) {
    const where = `plant[${i}]`;
    if (!p || typeof p !== 'object') { errors.push(`${where}: not an object`); continue; }
    if (typeof p.file !== 'string' || !p.file) { errors.push(`${where}: missing string "file"`); continue; }
    if (!Number.isInteger(p.line) || p.line < 1) { errors.push(`${where}: "line" must be a positive integer`); continue; }
    if (typeof p.original !== 'string') { errors.push(`${where}: missing string "original"`); continue; }
    if (typeof p.mutated !== 'string' || p.mutated === p.original) {
      errors.push(`${where}: "mutated" must be a string different from "original"`); continue;
    }
    const absolutePath = resolve(cwd, p.file);
    const content = readFileSafe(absolutePath);
    if (content === null) { errors.push(`${where}: cannot read ${p.file}`); continue; }
    const lines = content.split('\n');
    if (p.line > lines.length) { errors.push(`${where}: ${p.file} has only ${lines.length} lines`); continue; }
    if (lines[p.line - 1] !== p.original) {
      errors.push(`${where}: ${p.file}:${p.line} does not match "original" — refusing to apply drifted plant`);
      continue;
    }
    if (p.witness !== undefined && (typeof p.witness !== 'object' || typeof p.witness.cmd !== 'string')) {
      errors.push(`${where}: "witness" must be an object with a string "cmd"`); continue;
    }
    plants.push({
      file: p.file,
      absolutePath,
      line: p.line,
      operator: p.category ?? 'custom',
      category: p.category ?? 'custom',
      defect: typeof p.defect === 'string' && p.defect.trim()
        ? p.defect
        : `Planted defect at ${p.file}:${p.line} (\`${p.original.trim()}\` -> \`${p.mutated.trim()}\`)`,
      original: p.original,
      mutated: p.mutated,
      ...(p.witness ? { witness: p.witness } : {}),
    });
  }
  return { plants, errors };
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
      const entry = {
        file, absolutePath, line: m.line, operator: m.operator,
        category: operatorToCategory(m.operator),
        defect: describeDefect(m.operator, m.original, m.mutated),
        original: m.original, mutated: m.mutated,
      };
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
