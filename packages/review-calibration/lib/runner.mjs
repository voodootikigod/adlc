// review-calibration/lib/runner.mjs
// Apply all plants to the working tree, run the review command, restore tree.
// Uses a finally block so restoration is guaranteed even on throw/SIGINT.

import { writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * Tokenize a command template into argv elements, honoring single and double
 * quotes. Quotes group whitespace and are stripped from the resulting token.
 * This is a shell-free tokenizer — it does NOT interpret `$`, backticks,
 * pipes, redirects, or any other shell metacharacter.
 *
 * @param {string} template
 * @returns {string[]} argv tokens
 */
export function tokenizeCommand(template) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    throw new Error(`Unterminated quote in command template: ${template}`);
  }
  if (inToken) tokens.push(current);
  return tokens;
}

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
