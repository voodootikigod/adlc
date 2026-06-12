// review-calibration/lib/findings.mjs
// Parse a reviewer's output into structured findings. Verification needs
// findings as DATA, not prose — so a recall number reflects identified defects,
// not echoed lines. Pure functions, no I/O.

import { basename } from 'node:path';

/**
 * Normalized finding shape consumed by the scorer:
 *   { file, line, description, evidence, repro? }
 * - file/line locate the claim
 * - description is the reviewer's reasoning (what the judge reads)
 * - evidence is the verbatim quote the reviewer cited (optional)
 * - repro, when present, is a runnable reproduction → behavioral verification
 */

/**
 * Parse reviewer output into findings.
 *
 * Accepts, in order of preference:
 *   1. adversarial-review JSON: { findings: [{ file, line_start, title, body, evidence, recommendation, repro? }] }
 *   2. a bare JSON array of finding-like objects
 *   3. prose fallback: lines containing `path:line` become weak findings whose
 *      description IS the whole line (a prose reviewer can be consumed, but only
 *      weakly — documented as not rigorously calibratable)
 *
 * @param {string} output  combined stdout+stderr from the review command
 * @returns {Array<{file:string, line:number, description:string, evidence:string, repro?:object}>}
 */
export function parseFindings(output) {
  const json = tryParseJson(output);
  if (json) {
    const arr = Array.isArray(json) ? json : Array.isArray(json.findings) ? json.findings : null;
    if (arr) return arr.map(normalizeJsonFinding).filter(Boolean);
  }
  return parseProseFindings(output);
}

function tryParseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // The review command may print log lines around its JSON — try the whole
  // string first, then the largest {...} or [...] block.
  try {
    return JSON.parse(trimmed);
  } catch {
    const block = extractJsonBlock(trimmed);
    if (!block) return null;
    try {
      return JSON.parse(block);
    } catch {
      return null;
    }
  }
}

function extractJsonBlock(text) {
  const firstObj = text.indexOf('{');
  const firstArr = text.indexOf('[');
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return null;
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  if (end <= start) return null;
  return text.slice(start, end + 1);
}

function normalizeJsonFinding(f) {
  if (!f || typeof f !== 'object') return null;
  const file = f.file ?? f.path ?? f.filename ?? null;
  if (typeof file !== 'string' || !file) return null;
  const line = firstInt(f.line, f.line_start, f.lineNumber, f.lineno);
  if (line === null) return null;
  const description = [f.title, f.body, f.message, f.description, f.recommendation]
    .filter((s) => typeof s === 'string' && s.trim())
    .join(' — ');
  const evidence = typeof f.evidence === 'string' ? f.evidence : '';
  const finding = { file, line, description: description || evidence, evidence };
  if (f.repro && typeof f.repro === 'object') finding.repro = f.repro;
  return finding;
}

function firstInt(...vals) {
  for (const v of vals) {
    if (Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return parseInt(v, 10);
  }
  return null;
}

const PROSE_RE = /(?<path>[\w./\\-]+\.\w+):(?<line>\d+)/g;

/**
 * Prose fallback: each `path:line` mention becomes a finding whose description
 * is the line it appears on. Weak by construction — a prose reviewer that
 * merely echoes locations produces findings with no defect claim, which the
 * judge (or behavioral check) then rejects.
 */
export function parseProseFindings(output) {
  const findings = [];
  for (const rawLine of output.split('\n')) {
    PROSE_RE.lastIndex = 0;
    let m;
    while ((m = PROSE_RE.exec(rawLine)) !== null) {
      findings.push({
        file: basename(m.groups.path),
        line: parseInt(m.groups.line, 10),
        description: rawLine.trim(),
        evidence: rawLine.trim(),
      });
    }
  }
  return findings;
}
