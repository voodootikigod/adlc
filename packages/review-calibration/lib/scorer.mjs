// review-calibration/lib/scorer.mjs
// Scoring and matching logic: determine which planted bugs were caught by the
// reviewer's output. Pure functions — no I/O.

import { basename } from 'node:path';

/**
 * Regex to find "file:line"-style references in reviewer output.
 * Matches things like: foo.mjs:42, src/bar.js:100, path/to/baz.py:7
 */
const FILE_LINE_RE = /(?:[\w./\\-]+\.\w+):(\d+)/g;

/**
 * Determine whether a single plant was caught by the review output.
 *
 * A plant is CAUGHT if the review output satisfies ANY of:
 *  1. Mentions its file (basename match is enough) AND contains a line number
 *     within ±3 of the plant's line number.
 *  2. Contains a >= 12-character contiguous substring of the plant's mutated line.
 *
 * @param {string} reviewOutput   - Combined stdout + stderr from review command
 * @param {{ file: string, line: number, mutated: string }} plant
 * @returns {boolean}
 */
export function isPlantCaught(reviewOutput, plant) {
  const fileBase = basename(plant.file);

  // Condition 1: file mentioned AND nearby line number.
  if (reviewOutput.includes(fileBase)) {
    const lineNumbers = extractLineNumbers(reviewOutput, fileBase);
    for (const ln of lineNumbers) {
      if (Math.abs(ln - plant.line) <= 3) return true;
    }
  }

  // Condition 2: >=12-char substring of the mutated line appears in output.
  const mutatedTrimmed = plant.mutated.trim();
  if (mutatedTrimmed.length >= 12) {
    for (let start = 0; start <= mutatedTrimmed.length - 12; start++) {
      const snippet = mutatedTrimmed.slice(start, start + 12);
      if (reviewOutput.includes(snippet)) return true;
    }
  }

  return false;
}

/**
 * Extract line numbers mentioned near a filename in the review output.
 * Looks for "basename:NNN" patterns anywhere in the text.
 *
 * @param {string} output
 * @param {string} fileBase - basename of the file to search for
 * @returns {number[]} array of line numbers found
 */
export function extractLineNumbers(output, fileBase) {
  const numbers = [];
  // Pattern: <anything ending with fileBase>:<digits>
  // Use a regex that matches the basename followed by colon and digits.
  const escaped = fileBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:[\\w./\\\\-]*${escaped}):(\\d+)`, 'g');
  let m;
  while ((m = re.exec(output)) !== null) {
    numbers.push(parseInt(m[1], 10));
  }
  return numbers;
}

/**
 * Count "false positive" findings in the review output: file:line references
 * that look like real findings but do not match any plant within ±3 lines.
 *
 * @param {string} reviewOutput
 * @param {Array<{ file: string, line: number }>} plants
 * @returns {number}
 */
export function countFalsePositives(reviewOutput, plants) {
  // Build a set of (basename, line) pairs for all plants (with ±3 tolerance).
  // For each "file:line" in output, check if it matches a plant.
  const matches = [...reviewOutput.matchAll(FILE_LINE_RE)];
  let fps = 0;

  for (const match of matches) {
    const fullMatch = match[0]; // e.g. "foo.mjs:42"
    const lineNo = parseInt(match[1], 10);

    // Extract the file part (everything before the last colon+digits).
    const colonIdx = fullMatch.lastIndexOf(':');
    const filePart = fullMatch.slice(0, colonIdx);
    const fileBase = basename(filePart);

    // Check whether this finding matches any plant.
    const matchesPlant = plants.some((p) => {
      const pBase = basename(p.file);
      return pBase === fileBase && Math.abs(p.line - lineNo) <= 3;
    });

    if (!matchesPlant) fps++;
  }

  return fps;
}

/**
 * Score the review output against the full plant list.
 *
 * @param {string} reviewOutput
 * @param {Array<{ file: string, line: number, operator: string, original: string, mutated: string }>} plants
 * @returns {{
 *   recall: number,
 *   caught: number,
 *   total: number,
 *   falsePositives: number,
 *   perOperator: { [operator: string]: { caught: number, total: number, recall: number } },
 *   results: Array<{ file, line, operator, caught, original, mutated }>
 * }}
 */
export function scoreReview(reviewOutput, plants) {
  const perOperator = {};
  const results = [];
  let caught = 0;

  for (const plant of plants) {
    const wasCaught = isPlantCaught(reviewOutput, plant);
    if (wasCaught) caught++;

    results.push({
      file: plant.file,
      line: plant.line,
      operator: plant.operator,
      caught: wasCaught,
      original: plant.original,
      mutated: plant.mutated,
    });

    if (!perOperator[plant.operator]) {
      perOperator[plant.operator] = { caught: 0, total: 0, recall: 0 };
    }
    perOperator[plant.operator].total++;
    if (wasCaught) perOperator[plant.operator].caught++;
  }

  // Compute per-operator recall.
  for (const op of Object.values(perOperator)) {
    op.recall = op.total > 0 ? op.caught / op.total : 0;
  }

  const total = plants.length;
  const recall = total > 0 ? caught / total : 0;
  const falsePositives = countFalsePositives(reviewOutput, plants);

  return { recall, caught, total, falsePositives, perOperator, results };
}
