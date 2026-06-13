// gate-fuzzing/lib/candidate.mjs
// Schema validation (§1.2/§2.4) and pinned dedup hash (§3.3).

import { sha256 } from '@adlc/core';

const DEFAULT_ALLOWED_CMDS = new Set(['node', 'git', 'npm', 'npx']);

/**
 * Validate a candidate against the §1.2 schema contract.
 * Returns { valid: true } or { valid: false, reason: 'invalid:<which>' }.
 *
 * @param {object} candidate
 * @param {{allowedCmds?:Set<string>}} opts
 * @returns {{valid:boolean, reason?:string}}
 */
export function validateCandidate(candidate, opts = {}) {
  const allowedCmds = opts.allowedCmds ?? DEFAULT_ALLOWED_CMDS;

  // Required fields
  const required = ['target', 'claimKind', 'diff', 'witnessProposal'];
  for (const field of required) {
    if (!candidate[field]) {
      return { valid: false, reason: 'invalid:malformed' };
    }
  }

  // witnessProposal must have a cmd
  if (typeof candidate.witnessProposal !== 'object' || !candidate.witnessProposal.cmd) {
    return { valid: false, reason: 'invalid:malformed' };
  }

  // setup must be an array of arrays (argv arrays, not shell strings)
  if (candidate.setup !== undefined) {
    if (!Array.isArray(candidate.setup)) {
      return { valid: false, reason: 'invalid:malformed' };
    }
    for (const step of candidate.setup) {
      if (!Array.isArray(step)) {
        return { valid: false, reason: 'invalid:malformed' };
      }
      if (step.length === 0) {
        return { valid: false, reason: 'invalid:malformed' };
      }
    }
  }

  // Check witness cmd against allowlist
  if (!allowedCmds.has(candidate.witnessProposal.cmd)) {
    return { valid: false, reason: 'invalid:cmd' };
  }

  // Check all setup cmds against allowlist
  for (const step of (candidate.setup ?? [])) {
    const stepCmd = step[0];
    if (!allowedCmds.has(stepCmd)) {
      return { valid: false, reason: 'invalid:cmd' };
    }
  }

  return { valid: true };
}

/**
 * Normalize a diff and produce a pinned dedup hash (§3.3).
 * Strips:
 *   - unified-diff hunk header line numbers: @@ -a,b +c,d @@ → @@@@
 *   - index <sha>..<sha> lines
 *   - trailing whitespace per line
 * Then hashes (target, claimKind, normalizedDiff) so that two diffs differing
 * only in line offsets or git blob hashes hash equal, but different targets/claims
 * hash differently.
 *
 * @param {{target:string, claimKind:string, diff:string}} candidate
 * @returns {string} hex sha256
 */
export function normalizeAndHash({ target, claimKind, diff }) {
  const normalized = normalizeDiff(diff);
  return sha256(`${target}\x00${claimKind}\x00${normalized}`);
}

/**
 * Normalize a unified diff for dedup purposes.
 * @param {string} diff
 * @returns {string}
 */
export function normalizeDiff(diff) {
  return diff
    .split('\n')
    .map((line) => {
      // Strip hunk header line numbers: "@@ -1,3 +1,3 @@" → "@@@@"
      if (/^@@ /.test(line)) return '@@@@';
      // Strip index lines: "index abc123..def456 100644" → ""
      if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(line)) return '';
      // Strip trailing whitespace
      return line.trimEnd();
    })
    .filter((line) => line !== null) // keep empty strings (they become blank lines after normalize)
    .join('\n')
    // LF-only (in case of CRLF)
    .replace(/\r/g, '');
}

/**
 * Parse raw text from a model response into a candidate array.
 * Extracts JSON and validates schema. Returns { candidates, errors }.
 *
 * @param {string} rawText - Model output
 * @param {{extractJson:Function, allowedCmds?:Set<string>}} opts
 * @returns {{candidates:object[], errors:string[]}}
 */
export function parseCandidates(rawText, opts = {}) {
  const { extractJson, allowedCmds } = opts;
  const errors = [];
  const candidates = [];

  let parsed;
  try {
    parsed = extractJson(rawText);
  } catch (e) {
    errors.push(`invalid:malformed: ${e.message}`);
    return { candidates, errors };
  }

  // Model may return a single candidate or an array
  const items = Array.isArray(parsed) ? parsed : [parsed];

  for (const item of items) {
    const validation = validateCandidate(item, { allowedCmds });
    if (!validation.valid) {
      errors.push(validation.reason);
      continue;
    }
    candidates.push(item);
  }

  return { candidates, errors };
}
