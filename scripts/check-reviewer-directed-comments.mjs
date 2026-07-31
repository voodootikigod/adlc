#!/usr/bin/env node
/**
 * Refuse a committed source comment that references this project's OWN review
 * process (a round number, a finding id, "codex flagged", ...) alongside a word
 * that classifies or dismisses what it is describing ("not a defect", "not
 * independently closable", "don't re-litigate", "already accepted", ...).
 *
 * That combination is authority-smuggling: repository content instructing a
 * future reviewer — human or model — how to weigh a finding, rather than
 * describing the code's actual behavior and letting every reviewer judge
 * severity fresh. It has recurred three times in this codebase, each time
 * caught only by a live adversarial-review pass rather than a deterministic
 * gate: a spec doc with self-congratulatory "review status: closed" headers,
 * a test-file comment calling a known limitation "not a defect ... deferred
 * as a follow-on", and a code comment on a still-open limitation calling it
 * "not a new independently-closable bug". This gate turns that repeated
 * finding into a mechanical check instead of relying on the next review pass
 * to catch it again.
 *
 * Scans the FULL comment SPAN (block comment or a contiguous run of line
 * comments) surrounding every ADDED line in the diff against the freeze
 * baseline — reconstructed from the actual post-change file content, not just
 * the diff's added lines. A span whose classification half is unchanged
 * context and whose review-reference half is newly added (or vice versa)
 * still gets caught, because the whole span is scanned, not just its added
 * lines in isolation.
 *
 * There is deliberately NO blanket exemption for test files: a dismissive
 * comment about a still-open limitation is exactly as much an
 * authority-smuggling risk inside a test file as anywhere else — that is
 * literally how one of the three historical incidents happened. The only
 * exemption is this file and its own test file by exact path, because both
 * legitimately need to quote the trigger phrases verbatim as documentation
 * and test fixtures, not as live guidance about an open finding.
 *
 * Comment detection intentionally treats ANY line containing `//` or `#`
 * (even mid-line, even inside what might be a string literal) as starting a
 * comment span, and tracks `/* ... *\/` block state across ALL lines
 * regardless of a leading `*`. Telling "real comment" from "text that merely
 * contains these characters" would need a real tokenizer for every language
 * this repo's files use; the established convention here (see
 * scripts/block-secret-exposure.mjs) is to accept the rare false positive
 * over the risk of a silent bypass.
 *
 * Exit codes: 0 = clean, 2 = a violation was found, 1 = could not compute the diff.
 */

import { readFileSync } from 'node:fs';
import { resolveBase, changedFiles, gitDiff } from '@adlc/core';
import { parseAddedLines } from '@adlc/rails-guard/lib/suppressions.mjs';

// A comment referencing the review PROCESS itself — not the code's own behavior.
const REVIEW_PROCESS_REFERENCE = /\bround\s+\d+(\s+(finding|review))?\b|\bfinding\s*(#|id\b|-?id\b)|\bcluster[\s-]?id\b|\bcodex\s+(flagged|found|round)\b|\breviewer?\s+(flagged|found)\b|\breview\s+status\b/i;

// A word or phrase that CLASSIFIES or DISMISSES what the comment describes,
// rather than stating a fact about it.
const CLASSIFICATION_PHRASE = /\bnot\s+a\s+defect\b|\bdon'?t\s+re-?litigate\b|\bnot\s+(?:a\s+new\s+)?independently[\s-]closable\b|\balready\s+accepted\b|\bwon'?t\s+fix\b|\bno\s+action\s+needed\b|\bignore\s+this\s+finding\b|\bnot\s+flagged\b|\bdeferred,?\s+not\s+a\s+bug\b/i;

// A self-contained status ASSERTION that smuggles both roles (reference + verdict) in
// one short phrase, the exact shape of the historical incident this gate's own header
// describes: a spec doc with self-congratulatory "review status: closed" section
// headers. "closed"/"fixed"/"resolved" alone are far too common in ordinary comments
// ("fixed the null-check bug") to use as a bare classification word, so this only
// fires on the narrow, specific "review status: <verdict>" shape rather than either
// word in isolation.
const REVIEW_STATUS_ASSERTION = /\breview\s+status\s*:?\s*(closed|resolved|done|passed|complete)\b/i;

// This file and its own test file necessarily quote the exact phrases above, as
// documentation and as test fixtures — that is what they exist to describe/exercise,
// not an instance of the pattern itself. Exempted by exact path (not by weakening the
// pattern, and not by exempting any broader category like "every test file").
const SELF_EXEMPT_FILES = new Set([
  'scripts/check-reviewer-directed-comments.mjs',
  'scripts/test/check-reviewer-directed-comments.test.mjs',
]);

// Prose/doc files (a spec, an ADR, a README) have no code/comment distinction — the
// WHOLE file is documentation, the same category of content a `//`/`#` comment is in a
// source file. The historical incident this predates (a spec doc's self-congratulatory
// "review status: closed" section headers) was exactly this: plain prose, not a code
// comment. Treating every line as scannable for these extensions closes that gap
// instead of relying on an accidental match (a markdown `#` heading happens to look
// like a shell comment marker, but plain prose text does not).
const PROSE_FILE = /\.(md|markdown|mdx)$/i;

/**
 * Per-line comment classification for one file's full text. A line is "in a comment"
 * if it is inside an open `/* ... *\/` block, OR it contains `//`/`#` anywhere (an
 * inline trailing comment counts), OR the file is a prose/doc file (every line counts).
 * `text` is the comment-only portion of the line.
 * @param {string[]} lines
 * @param {boolean} [treatEveryLineAsComment]
 * @returns {{isComment: boolean, text: string}[]}
 */
function classifyLines(lines, treatEveryLineAsComment = false) {
  if (treatEveryLineAsComment) {
    return lines.map((line) => ({ isComment: true, text: line }));
  }
  const result = [];
  let inBlock = false;
  for (const line of lines) {
    if (inBlock) {
      const endIdx = line.indexOf('*/');
      if (endIdx === -1) {
        result.push({ isComment: true, text: line });
      } else {
        result.push({ isComment: true, text: line.slice(0, endIdx + 2) });
        inBlock = false;
      }
      continue;
    }
    const blockIdx = line.indexOf('/*');
    const lineCommentMatch = line.match(/\/\/|#/);
    const lineIdx = lineCommentMatch ? line.indexOf(lineCommentMatch[0]) : -1;
    if (blockIdx !== -1 && (lineIdx === -1 || blockIdx < lineIdx)) {
      const endIdx = line.indexOf('*/', blockIdx + 2);
      if (endIdx === -1) {
        inBlock = true;
        result.push({ isComment: true, text: line.slice(blockIdx) });
      } else {
        result.push({ isComment: true, text: line.slice(blockIdx, endIdx + 2) });
      }
      continue;
    }
    if (lineIdx !== -1) {
      result.push({ isComment: true, text: line.slice(lineIdx) });
      continue;
    }
    result.push({ isComment: false, text: '' });
  }
  return result;
}

/**
 * Every maximal comment span in `lines` (1-indexed start/end), each carrying its full
 * joined text regardless of which lines within it were actually changed.
 * @param {string[]} lines
 * @param {boolean} [treatEveryLineAsComment]
 * @returns {{startLine: number, endLine: number, text: string}[]}
 */
function commentSpans(lines, treatEveryLineAsComment = false) {
  const classified = classifyLines(lines, treatEveryLineAsComment);
  const spans = [];
  let start = -1;
  let texts = [];
  for (let i = 0; i < classified.length; i++) {
    if (classified[i].isComment) {
      if (start === -1) start = i;
      texts.push(classified[i].text);
    } else if (start !== -1) {
      spans.push({ startLine: start + 1, endLine: i, text: texts.join('\n') });
      start = -1;
      texts = [];
    }
  }
  if (start !== -1) spans.push({ startLine: start + 1, endLine: classified.length, text: texts.join('\n') });
  return spans;
}

/**
 * @param {string} [base] override for the freeze baseline (test injection)
 * @param {{resolveBase?: Function, changedFiles?: Function, gitDiff?: Function, readFile?: Function}} [deps]
 * @returns {number} exit code
 */
export function check(base, deps = {}) {
  const resolveBaseFn = deps.resolveBase ?? resolveBase;
  const changedFilesFn = deps.changedFiles ?? changedFiles;
  const gitDiffFn = deps.gitDiff ?? gitDiff;
  const readFileFn = deps.readFile ?? ((file) => readFileSync(file, 'utf8'));

  const resolvedBase = base ?? resolveBaseFn();
  if (!resolvedBase) {
    console.error('check-reviewer-directed-comments: could not resolve a diff baseline (no main/master/origin ref found).');
    return 1;
  }

  let files;
  let diffText;
  try {
    files = changedFilesFn(resolvedBase);
    diffText = gitDiffFn(resolvedBase);
  } catch (err) {
    console.error(`check-reviewer-directed-comments: could not compute the diff: ${err.message}`);
    return 1;
  }

  const addedByFile = new Map();
  for (const { file, lineNo } of parseAddedLines(diffText)) {
    if (SELF_EXEMPT_FILES.has(file)) continue;
    if (!addedByFile.has(file)) addedByFile.set(file, new Set());
    addedByFile.get(file).add(lineNo);
  }

  const violations = [];
  let spanCount = 0;
  for (const file of files) {
    const addedLineNos = addedByFile.get(file);
    if (!addedLineNos || addedLineNos.size === 0) continue;

    let content;
    try {
      content = readFileFn(file);
    } catch {
      continue; // deleted or unreadable at the diff's "after" state — nothing to scan
    }

    const spans = commentSpans(content.split('\n'), PROSE_FILE.test(file));
    for (const span of spans) {
      let touchedByAddedLine = false;
      for (let ln = span.startLine; ln <= span.endLine; ln++) {
        if (addedLineNos.has(ln)) { touchedByAddedLine = true; break; }
      }
      if (!touchedByAddedLine) continue;
      spanCount++;
      const isViolation = (REVIEW_PROCESS_REFERENCE.test(span.text) && CLASSIFICATION_PHRASE.test(span.text))
        || REVIEW_STATUS_ASSERTION.test(span.text);
      if (isViolation) {
        violations.push({ file, startLine: span.startLine });
      }
    }
  }

  if (violations.length > 0) {
    console.error(`check-reviewer-directed-comments: ${violations.length} comment(s) reference this project's own review process alongside a classification/dismissal phrase:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.startLine}`);
    }
    console.error(
      '\nDescribe the code\'s actual behavior and cause in neutral, factual terms. Do not reference '
      + 'review rounds, finding ids, or classify the finding as new/old/closable — let every future '
      + 'reviewer (human or model) judge severity fresh.',
    );
    return 2;
  }

  console.log(`check-reviewer-directed-comments: ${spanCount} comment span(s) touched by the diff checked, clean.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = check(process.argv[2]);
}
