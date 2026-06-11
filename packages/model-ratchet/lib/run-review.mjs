// run-review.mjs — Execute the --review-cmd per file and parse findings.

import { spawnSync } from 'node:child_process';

/**
 * Tokenize a command template into argv elements, honoring single and double
 * quotes (so `--msg "hello world"` becomes two argv elements). Quotes only
 * group whitespace; they are stripped from the resulting token. This is a
 * deliberately small, shell-free tokenizer — it does NOT interpret `$`,
 * backticks, pipes, redirects, globs, or any other shell metacharacter.
 *
 * @param {string} template
 * @returns {string[]} argv tokens
 */
export function tokenizeCommand(template) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null; // "'" | '"' | null

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
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
 * Substitute {file} into a tokenized command. The untrusted value is placed
 * into argv tokens as a LITERAL — the value is never re-tokenized, so a
 * filename containing shell metacharacters (spaces, `$(...)`, backticks, `;`)
 * stays a single discrete argument and is never interpreted by a shell.
 *
 * A token like `--file={file}` yields `--file=<value>`; a bare `{file}`
 * token yields exactly `<value>`.
 *
 * @param {string[]} tokens
 * @param {string} placeholder  e.g. '{file}'
 * @param {string} value        untrusted substitution value
 * @returns {string[]}
 */
export function substituteToken(tokens, placeholder, value) {
  return tokens.map((tok) => tok.split(placeholder).join(value));
}

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
export function parseFindingLine(line, _file) {
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
  // Tokenize the trusted template, THEN substitute the untrusted file path as
  // a discrete argv element. Run with shell:false so the filename is never
  // re-parsed by /bin/sh — this closes the command-injection hole that existed
  // when the template string was interpolated and run with shell:true.
  const tokens = substituteToken(tokenizeCommand(reviewCmd), '{file}', file);
  if (tokens.length === 0) {
    return { stdout: '', stderr: 'empty review command', exitCode: 1 };
  }
  const result = spawnSync(tokens[0], tokens.slice(1), {
    shell: false,
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
