// review-calibration/lib/runner.mjs
// Apply all plants to the working tree, run the review command, restore tree.
// Uses a finally block so restoration is guaranteed even on throw/SIGINT.

import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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
 * @returns {{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean }}
 */
export function runWithPlants(plants, reviewCmd, baseRef, cwd, timeoutMs) {
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

  // Write mutated content to each file.
  try {
    for (const [absPath, filePlants] of byFile) {
      const original = originals.get(absPath);
      const mutated = applyAllPlantsToContent(original, filePlants);
      writeFileSync(absPath, mutated, 'utf8');
    }

    // Build the command with {base} substituted.
    const cmd = reviewCmd.replace(/\{base\}/g, baseRef);

    // Run the review command.
    const result = spawnSync(cmd, {
      shell: true,
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
    // Always restore all files, even if an error occurred.
    for (const [absPath, originalContent] of originals) {
      try {
        writeFileSync(absPath, originalContent, 'utf8');
      } catch {
        // Best-effort restore — don't mask the original error.
      }
    }
  }
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
