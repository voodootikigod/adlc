// review-calibration/lib/runner.mjs
// Apply all plants to the working tree, run the review command, restore tree.
// Restoration runs in a finally block, so a throw restores too. A process
// killed while the review runs cannot restore anything itself; the journal's
// in-flight record is what lets the next run do it (see inflight.mjs).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tokenizeCommand } from '@adlc/core';
import { writeFileAtomic, NO_JOURNAL } from './inflight.mjs';

export { tokenizeCommand };

/**
 * Substitute a placeholder into a tokenized command. The (untrusted) value is
 * placed into argv tokens as a LITERAL and never re-tokenized, so a ref
 * containing shell metacharacters stays a single discrete argument.
 *
 * @param {string[]} tokens
 * @param {string} placeholder  e.g. '{base}'
 * @param {string} value        untrusted substitution value
 * @returns {string[]}
 */
export function substituteToken(tokens, placeholder, value) {
  return tokens.map((tok) => tok.split(placeholder).join(value));
}

/**
 * Apply a set of plants (mutants) to the working tree simultaneously,
 * run the review command, then restore all files.
 *
 * Each plant: { absolutePath, line, original, mutated, ... }
 * All plants from the same file are applied in one pass (last write wins per file;
 * since each plant targets a different line we merge them properly).
 *
 * @param {Array<{ absolutePath: string, line: number, original: string, mutated: string }>} plants
 * @param {string} reviewCmd  - Shell command; {base} is replaced with baseRef
 * @param {string} baseRef    - The commit ref to substitute for {base}
 * @param {string} cwd        - Working directory for the review command
 * @param {number} timeoutMs  - Timeout in milliseconds
 * @param {object} [options]
 * @param {{begin:Function, end:Function}} [options.journal]  records the plants
 *   before any file is written; begin throwing aborts before planting
 * @returns {{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean }}
 */
export function runWithPlants(plants, reviewCmd, baseRef, cwd, timeoutMs, { journal = NO_JOURNAL } = {}) {
  // Group plants by absolutePath.
  const byFile = groupByFile(plants);

  // Save originals keyed by absolutePath.
  const originals = new Map();
  for (const [absPath] of byFile) {
    try {
      originals.set(absPath, readFileSync(absPath, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot read file for planting: ${absPath} — ${err.message}`);
    }
  }

  const planted = [...byFile].map(([absolutePath, filePlants]) => {
    const original = originals.get(absolutePath);
    return { absolutePath, original, mutated: applyAllPlantsToContent(original, filePlants) };
  });
  journal.begin(planted);

  try {
    for (const { absolutePath, mutated } of planted) writeFileAtomic(absolutePath, mutated);

    // Tokenize the trusted template, THEN substitute the base ref as a
    // discrete argv element. Run with shell:false so the ref is never re-parsed
    // by /bin/sh — closing the command-injection class present when the
    // template was interpolated and run with shell:true.
    const argv = substituteToken(tokenizeCommand(reviewCmd), '{base}', baseRef);
    if (argv.length === 0) {
      return { stdout: '', stderr: 'empty review command', exitCode: 1, timedOut: false };
    }

    // Run the review command.
    const result = spawnSync(argv[0], argv.slice(1), {
      shell: false,
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    const timedOut = result.signal === 'SIGTERM' || result.status === null;
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      exitCode: result.status,
      timedOut,
    };
  } finally {
    restoreAll(originals, journal);
  }
}

/**
 * Restore every original. The record is cleared only when all of them were
 * written back; otherwise it stays for the next run to finish the job.
 */
function restoreAll(originals, journal) {
  let restored = true;
  for (const [absPath, originalContent] of originals) {
    try {
      writeFileAtomic(absPath, originalContent);
    } catch {
      restored = false; // don't mask the original error; the record remains
    }
  }
  if (restored) journal.end();
}

/**
 * Group plant entries by their absolutePath.
 *
 * @param {Array<{ absolutePath: string, line: number, original: string, mutated: string }>} plants
 * @returns {Map<string, Array>}
 */
export function groupByFile(plants) {
  const map = new Map();
  for (const plant of plants) {
    if (!map.has(plant.absolutePath)) map.set(plant.absolutePath, []);
    map.get(plant.absolutePath).push(plant);
  }
  return map;
}

/**
 * Apply multiple plant mutants to a single file's content.
 * Plants are applied by line number (1-based). Multiple plants on the same
 * line are collapsed to the last one (shouldn't happen given selection logic).
 *
 * @param {string} content  - Original file content
 * @param {Array<{ line: number, original: string, mutated: string }>} filePlants
 * @returns {string} mutated content
 */
export function applyAllPlantsToContent(content, filePlants) {
  const lines = content.split('\n');
  // Sort plants by line so we apply them in order (no index shifting needed
  // since we're doing direct line replacement, not splice).
  const sorted = [...filePlants].sort((a, b) => a.line - b.line);

  for (const plant of sorted) {
    const idx = plant.line - 1;
    if (idx < 0 || idx >= lines.length) continue;
    // Only apply if the original still matches (skip if a prior plant on the
    // same line already changed it).
    if (lines[idx] === plant.original) {
      lines[idx] = plant.mutated;
    }
  }

  return lines.join('\n');
}
