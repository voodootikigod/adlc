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
 * as a follow-on" (codex round 9, CRITICAL), and a code comment on a still-open
 * limitation calling it "not a new independently-closable bug" (a later round,
 * also CRITICAL). This gate turns that repeated finding into a mechanical check
 * instead of relying on the next review pass to catch it again.
 *
 * Scans only ADDED lines in the diff against the freeze baseline (parseAddedLines),
 * not the whole file — an unrelated edit to a file that already contains an
 * old-style reference must not fail this gate. Test files are exempt: a comment
 * explaining why a REGRESSION TEST exists ("regression test for round N finding")
 * documents a fixed, verified behavior — it does not classify an open one, and is
 * the normal, universal way software documents what a test guards against.
 *
 * Exit codes: 0 = clean, 2 = a violation was found, 1 = could not compute the diff.
 */

import { resolveBase, changedFiles, gitDiff } from '@adlc/core';
import { parseAddedLines } from '@adlc/rails-guard/lib/suppressions.mjs';

// A comment referencing the review PROCESS itself — not the code's own behavior.
const REVIEW_PROCESS_REFERENCE = /\bround\s+\d+(\s+(finding|review))?\b|\bfinding\s*(#|id\b|-?id\b)|\bcluster[\s-]?id\b|\bcodex\s+(flagged|found|round)\b|\breviewer?\s+(flagged|found)\b/i;

// A word or phrase that CLASSIFIES or DISMISSES what the comment describes,
// rather than stating a fact about it.
const CLASSIFICATION_PHRASE = /\bnot\s+a\s+defect\b|\bdon'?t\s+re-?litigate\b|\bnot\s+(?:a\s+new\s+)?independently[\s-]closable\b|\balready\s+accepted\b|\bnot\s+(?:a\s+)?new\b(?:[^.]{0,20}\bbug\b)?|\bwon'?t\s+fix\b|\bno\s+action\s+needed\b|\bignore\s+this\s+finding\b|\bnot\s+flagged\b|\bdeferred,?\s+not\s+a\s+bug\b/i;

const COMMENT_LINE = /^\s*(\/\/|\*(?!\/)|\/\*|#)/;

const TEST_FILE = /(^|\/)test\/|\.test\.mjs$|\.spec\.mjs$/;

/**
 * Group consecutive added comment lines within one file into blocks, so a
 * multi-line comment is checked as a whole rather than line by line (the review
 * reference and the classification phrase are often on different lines of the
 * same comment).
 * @param {{file: string, lineNo: number, content: string}[]} addedLines
 * @returns {{file: string, startLine: number, text: string}[]}
 */
function groupCommentBlocks(addedLines) {
  const blocks = [];
  let current = null;
  for (const { file, lineNo, content } of addedLines) {
    if (COMMENT_LINE.test(content)) {
      if (current && current.file === file && lineNo === current.lastLine + 1) {
        current.text += `\n${content}`;
        current.lastLine = lineNo;
      } else {
        current = { file, startLine: lineNo, lastLine: lineNo, text: content };
        blocks.push(current);
      }
    } else {
      current = null;
    }
  }
  return blocks;
}

/**
 * @param {string} [base] override for the freeze baseline (test injection)
 * @param {{resolveBase?: Function, changedFiles?: Function, gitDiff?: Function}} [deps]
 * @returns {number} exit code
 */
export function check(base, deps = {}) {
  const resolveBaseFn = deps.resolveBase ?? resolveBase;
  const changedFilesFn = deps.changedFiles ?? changedFiles;
  const gitDiffFn = deps.gitDiff ?? gitDiff;

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

  const testFiles = new Set(files.filter((f) => TEST_FILE.test(f)));
  const addedLines = parseAddedLines(diffText).filter((l) => !testFiles.has(l.file));
  const blocks = groupCommentBlocks(addedLines);

  const violations = blocks.filter(
    (b) => REVIEW_PROCESS_REFERENCE.test(b.text) && CLASSIFICATION_PHRASE.test(b.text),
  );

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

  console.log(`check-reviewer-directed-comments: ${blocks.length} added comment block(s) checked, clean.`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = check(process.argv[2]);
}
