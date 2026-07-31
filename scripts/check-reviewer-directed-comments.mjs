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
import { resolveBase, changedFiles, git } from '@adlc/core';

// A unified-diff header path can desync from the true path for names containing
// spaces, tabs, quotes, or newlines: git appends a trailing tab to a space-bearing
// name and double-quotes/escapes tab-, quote-, or newline-bearing names, while
// changedFiles() (NUL-delimited, decode-verified) returns the exact byte-true path
// (see @adlc/core's gitDiff docstring). Joining the two by string equality — as a
// whole-repo diff parsed once and matched against changedFiles() output would
// require — silently drops such files from coverage. Diffing each changedFiles()
// path individually sidesteps the mismatch entirely: every touched line in a diff
// scoped to exactly one path belongs to that path, so no header text is ever
// consulted for file identity here, only line numbers (which core.quotepath cannot
// affect, only header display — so it is not set here).
function gitDiffForFile(base, file) {
  return git(['diff', base, '--', file]);
}

// A base-vs-INDEX diff, for the same reason changedFiles() (@adlc/core) unions
// worktree and --cached diffs (see its own docstring, #244): a plain `git diff
// base` never consults the index, so a violation staged and then reverted in the
// working tree diffs empty locally, yet `git commit` (no -a) records the staged
// content. Scanning only the worktree diff would pass a tree locally that is not
// the one about to be committed.
function gitDiffForFileStaged(base, file) {
  return git(['diff', '--cached', base, '--', file]);
}

// The file's content AS STAGED (what `git commit` would record), independent of
// what the working tree currently holds. Returns null for a path with no staged
// blob (never staged, or staged as a deletion) — the caller falls back to treating
// it as absent, matching readFileFn's own ENOENT handling for a deleted file.
function readStagedFile(file) {
  try {
    // Failing (no staged blob) is the expected, common case for most changed
    // files — suppress git's stderr for it rather than printing "fatal: ambiguous
    // argument" noise on every clean run.
    return git(['show', `:${file}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

// Post-change (new-file) line numbers this diff TOUCHED: every added line, plus the
// post-change line immediately before and after every deletion. Deleting the code
// between two pre-existing, individually-harmless comment runs can merge them into
// one contiguous, newly-authority-smuggling span while producing a deletion-only
// patch — no line in the merged span was itself ADDED, so tracking added lines
// alone misses it. Marking the deletion's boundary lines as touched, in addition to
// every added line, catches this without needing full before/after span diffing.
//
// Written locally (not via the shared parseAddedLines) so a single-file-scoped diff
// is walked directly: hunk state closes once its declared old/new line counts are
// consumed, so a concatenated multi-file diff with no `diff --git` separators
// between hunks is handled correctly too, not just diffs @adlc/core's git module
// itself produces.
function touchedLineNumbers(diffText) {
  const touched = new Set();
  // Never read before the `@@` branch below sets them, and that branch sets
  // `inHunk = true` in the same step whenever it sets the others — so no initial
  // value here is ever observed; left uninitialized rather than given a literal a
  // mutation test could flip without changing behavior.
  let newLineNo;
  let oldRemaining;
  let newRemaining;
  let inHunk;

  for (const raw of diffText.split('\n')) {
    // Load-bearing independently of the count-based closing check below: a hunk
    // header that OVER-declares its line count never reaches the exact-zero close
    // on its own, so without this hard reset a following file's lines stay
    // misattributed (see the "lying hunk header" test).
    if (raw.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }

    // Strict equality (not <=): both counters only ever reach exactly 0 while
    // inHunk is being actively decremented, never negative, since this check
    // itself stops further decrementing the moment they do.
    if (inHunk && oldRemaining === 0 && newRemaining === 0) inHunk = false;

    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        oldRemaining = m[2] !== undefined ? parseInt(m[2], 10) : 1;
        newRemaining = m[4] !== undefined ? parseInt(m[4], 10) : 1;
        newLineNo = parseInt(m[3], 10) - 1;
        inHunk = true;
      }
      continue;
    }

    if (!inHunk) continue; // a header line (---/+++), or text between diff sections

    if (raw.startsWith(' ')) {
      newLineNo++;
      oldRemaining--;
      newRemaining--;
      continue;
    }
    if (raw.startsWith('-')) {
      oldRemaining--;
      touched.add(newLineNo);
      touched.add(newLineNo + 1);
      continue;
    }
    if (raw.startsWith('+')) {
      newLineNo++;
      newRemaining--;
      touched.add(newLineNo);
      continue;
    }
  }
  return touched;
}

// A comment referencing the review PROCESS itself — not the code's own behavior.
const REVIEW_PROCESS_REFERENCE = /\bround\s+\d+(\s+(finding|review))?\b|\bfinding\s*(#|id\b|-?id\b|\d)|\bcluster[\s-]?id\b|\bcodex\s+(flagged|found|round)\b|\breviewer?\s+(flagged|found)\b|\breview\s+status\b/i;

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
// like a shell comment marker, but plain prose text does not). `.mdc` (Cursor agent
// rule files, e.g. plugins/adlc-cursor/rules/*.mdc) is plain-text model instruction
// content with no comment marker of its own, the same category of risk as the other
// prose extensions here.
const PROSE_FILE = /\.(md|markdown|mdx|mdc)$/i;

// Block-comment marker pairs recognized in code files, checked in order at each
// position — C-style `/* */` (JS/TS/CSS/...) and HTML/XML/SVG-style `<!-- -->`
// (this repo's .svg/.tsx/.html content can carry the latter; a reviewer-directed
// dismissal hidden in one is exactly as much a risk as in a `//` comment).
const BLOCK_COMMENT_MARKERS = [
  ['/*', '*/'],
  ['<!--', '-->'],
];

/**
 * Per-line comment classification for one file's full text. A line is "in a comment"
 * if it is inside an open block comment (`/* ... *\/` or `<!-- ... -->`), OR it
 * contains `//`/`#` anywhere (an inline trailing comment counts), OR the file is a
 * prose/doc file (every line counts). `text` is the comment-only portion of the line.
 * @param {string[]} lines
 * @param {boolean} treatEveryLineAsComment
 * @returns {{isComment: boolean, text: string}[]}
 */
function classifyLines(lines, treatEveryLineAsComment) {
  if (treatEveryLineAsComment) {
    return lines.map((line) => ({ isComment: true, text: line }));
  }

  const result = [];
  let blockClose = null; // the closing marker we're waiting for, or null if not in a block
  for (const line of lines) {
    let text = '';
    let sawComment = false;
    let pos = 0;

    if (blockClose !== null) {
      const endIdx = line.indexOf(blockClose);
      if (endIdx === -1) {
        result.push({ isComment: true, text: line });
        continue;
      }
      text = line.slice(0, endIdx + blockClose.length);
      sawComment = true;
      pos = endIdx + blockClose.length;
      blockClose = null;
    }

    // Iteratively consume every remaining comment segment on the line — a line can
    // carry more than one (`/* round 9 finding */ /* not a defect */`, or a closed
    // block followed by a `//`/`#` comment) — rather than stopping after the first.
    while (pos < line.length) {
      const rest = line.slice(pos);

      // The earliest-starting block-comment marker pair, if any.
      let block = null;
      for (const [open, close] of BLOCK_COMMENT_MARKERS) {
        const idx = rest.indexOf(open);
        if (idx !== -1 && (block === null || idx < block.idx)) block = { idx, open, close };
      }

      const lineCommentMatch = rest.match(/\/\/|#/);
      const lineIdx = lineCommentMatch ? rest.indexOf(lineCommentMatch[0]) : -1;

      if (block === null && lineIdx === -1) break;

      if (lineIdx !== -1 && (block === null || lineIdx < block.idx)) {
        text += rest.slice(lineIdx);
        sawComment = true;
        break; // a line comment always consumes the rest of the line
      }

      const endIdx = rest.indexOf(block.close, block.idx + block.open.length);
      if (endIdx === -1) {
        text += rest.slice(block.idx);
        sawComment = true;
        blockClose = block.close;
        break;
      }
      text += rest.slice(block.idx, endIdx + block.close.length);
      sawComment = true;
      pos += endIdx + block.close.length;
    }

    result.push(sawComment ? { isComment: true, text } : { isComment: false, text: '' });
  }
  return result;
}

/**
 * Every maximal comment span in `lines` (1-indexed start/end), each carrying its full
 * joined text regardless of which lines within it were actually changed.
 * @param {string[]} lines
 * @param {boolean} treatEveryLineAsComment
 * @returns {{startLine: number, endLine: number, text: string}[]}
 */
function commentSpans(lines, treatEveryLineAsComment) {
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
 * @param {{resolveBase?: Function, changedFiles?: Function, gitDiff?: Function, gitDiffStaged?: Function, readFile?: Function, readStagedFile?: Function}} [deps]
 *        `gitDiff`/`gitDiffStaged`, if provided, are each called as `(base, file)` and
 *        must return a diff scoped to that single file (matching gitDiffForFile's /
 *        gitDiffForFileStaged's contract), not a whole-repo diff. `readStagedFile`, if
 *        provided, is called as `(file)` and must return the staged content string, or
 *        `null` if the path has no staged blob (matching readStagedFile's contract).
 * @returns {number} exit code
 */
export function check(base, deps = {}) {
  const resolveBaseFn = deps.resolveBase ?? resolveBase;
  const changedFilesFn = deps.changedFiles ?? changedFiles;
  const gitDiffFn = deps.gitDiff ?? gitDiffForFile;
  const gitDiffStagedFn = deps.gitDiffStaged ?? gitDiffForFileStaged;
  const readFileFn = deps.readFile ?? ((file) => readFileSync(file, 'utf8'));
  const readStagedFileFn = deps.readStagedFile ?? readStagedFile;

  const resolvedBase = base ?? resolveBaseFn();
  if (!resolvedBase) {
    console.error('check-reviewer-directed-comments: could not resolve a diff baseline (no main/master/origin ref found).');
    return 1;
  }

  let files;
  try {
    files = changedFilesFn(resolvedBase);
  } catch (err) {
    console.error(`check-reviewer-directed-comments: could not compute the diff: ${err.message}`);
    return 1;
  }

  const violations = [];
  let spanCount = 0;

  // Scans one (diffText, content) pairing for `file` and records any violation.
  // Called once for the worktree state and once for the staged (index) state — a
  // violation staged and then reverted in the working tree diffs empty against the
  // worktree alone, yet `git commit` (no -a) records the staged content, so both
  // must be checked for `check()` to be accurate about what is about to be
  // committed, not just what is currently on disk.
  function scan(file, diffText, content) {
    const touchedLines = touchedLineNumbers(diffText);
    if (touchedLines.size === 0) return;

    const spans = commentSpans(content.split('\n'), PROSE_FILE.test(file));
    for (const span of spans) {
      let touched = false;
      for (let ln = span.startLine; ln <= span.endLine; ln++) {
        if (touchedLines.has(ln)) { touched = true; break; }
      }
      if (!touched) continue;
      spanCount++;
      const isViolation = (REVIEW_PROCESS_REFERENCE.test(span.text) && CLASSIFICATION_PHRASE.test(span.text))
        || REVIEW_STATUS_ASSERTION.test(span.text);
      if (isViolation) {
        violations.push({ file, startLine: span.startLine });
      }
    }
  }

  for (const file of files) {
    if (SELF_EXEMPT_FILES.has(file)) continue;

    let worktreeDiff;
    let stagedDiff;
    try {
      worktreeDiff = gitDiffFn(resolvedBase, file);
      stagedDiff = gitDiffStagedFn(resolvedBase, file);
    } catch (err) {
      console.error(`check-reviewer-directed-comments: could not compute the diff for ${file}: ${err.message}`);
      return 1;
    }

    try {
      scan(file, worktreeDiff, readFileFn(file));
    } catch {
      // deleted or unreadable at the diff's "after" state — nothing to scan
    }

    const stagedContent = readStagedFileFn(file);
    if (stagedContent !== null) {
      scan(file, stagedDiff, stagedContent);
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
