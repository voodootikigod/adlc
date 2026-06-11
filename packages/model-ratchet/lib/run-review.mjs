// run-review.mjs — Execute the --review-cmd per file and parse findings.

import { spawnSync } from 'node:child_process';

// A finding line is either:
//   - matches /\S+:\d+/ anywhere  (e.g. "src/foo.js:42: something wrong")
//   - starts with '- '            (bullet item)
const FINDING_LINE_RE = /\S+:\d+/;

/**
 * Determine if a stdout line from the review command is a finding.
 * @param {string} line
 */
export function isFindingLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('- ')) return true;
  if (FINDING_LINE_RE.test(trimmed)) return true;
  return false;
}

/**
 * Parse a finding line to extract an optional location.
 * Returns { location: 'file:line' | null, desc: string }
 *
 * If line is "path/to/file.js:42: message", extract location.
 * If line starts with "- ", use as-is description.
 *
 * @param {string} line
 * @param {string} file  - the file being reviewed (used as context)
 */
export function parseFindingLine(line, file) {
  const trimmed = line.trim();
  // Try to extract file:lineNo from start of line
  const locMatch = trimmed.match(/^(\S+):(\d+)(?::.*)?$/);
  if (locMatch) {
    return {
      location: `${locMatch[1]}:${locMatch[2]}`,
      parsedLine: parseInt(locMatch[2], 10),
      desc: trimmed,
    };
  }
  // Inline reference (not at start)
  const inlineMatch = trimmed.match(/\S+:\d+/);
  if (inlineMatch) {
    return {
      location: inlineMatch[0],
      parsedLine: null,
      desc: trimmed,
    };
  }
  return { location: null, parsedLine: null, desc: trimmed };
}

/**
 * Run the review command for a single file.
 *
 * @param {string} reviewCmd  - command template with {file} placeholder
 * @param {string} file       - repo-relative file path
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
export function runReviewCmd(reviewCmd, file) {
  const cmd = reviewCmd.replace(/\{file\}/g, file);
  const result = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

/**
 * Parse findings from the stdout of a review command run.
 *
 * @param {string} stdout
 * @param {string} file    - file being reviewed (for context in entries)
 * @returns {Array<{ts, tool, file, line, category, severity, desc}>}
 */
export function parseFindingsFromOutput(stdout, file) {
  const findings = [];
  const ts = new Date().toISOString();
  for (const rawLine of stdout.split('\n')) {
    if (!isFindingLine(rawLine)) continue;
    const { parsedLine, desc } = parseFindingLine(rawLine, file);
    findings.push({
      ts,
      tool: 'model-ratchet',
      file,
      line: parsedLine,
      category: 'ratchet',
      severity: 'unknown',
      desc,
    });
  }
  return findings;
}
