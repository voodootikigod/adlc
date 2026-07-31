// The lint gate for authority-smuggling comments: a source comment that references
// this project's OWN review process (a round number, a finding id) alongside a
// classification/dismissal phrase ("not a defect", "not independently closable") is
// flagged. This pattern recurred three times before this gate existed, each time
// caught only by a live adversarial-review pass rather than a deterministic check.
//
// The gate reconstructs the FULL comment span (block or line-comment run) around every
// added line from the actual post-change file content — not just the diff's added
// lines — so a violation split across changed and unchanged lines is still caught.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../check-reviewer-directed-comments.mjs';

// Builds a real unified diff whose "new file" side is exactly `fullLines`, marking the
// 1-indexed line numbers in `addedLineNos` as added ('+') and everything else as
// unchanged context (' '), so parseAddedLines reports precisely those lines as added.
function buildDiff(file, fullLines, addedLineNos) {
  const addedSet = new Set(addedLineNos);
  const body = fullLines.map((line, i) => `${addedSet.has(i + 1) ? '+' : ' '}${line}`).join('\n');
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${fullLines.length} @@\n${body}\n`;
}

function run(file, fullLines, addedLineNos) {
  const deps = {
    resolveBase: () => 'origin/main',
    changedFiles: () => [file],
    gitDiff: () => buildDiff(file, fullLines, addedLineNos),
    readFile: (f) => (f === file ? fullLines.join('\n') : (() => { throw new Error('ENOENT'); })()),
  };
  return check(undefined, deps);
}

// Convenience for the common case: every line in `lines` is newly added (a fresh file
// or a fully-added block), matching the original test style.
function runAllAdded(file, lines) {
  return run(file, lines, lines.map((_, i) => i + 1));
}

test('passes a normal, factual comment with no review-process reference', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// This is a residual limitation: the check cannot close a concurrent rename',
    '// window because Node has no fd-relative open primitive.',
  ]), 0);
});

test('passes a review-process reference with NO classification phrase', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Fixed in round 8: the write now happens after confinement, not before.',
  ]), 0);
});

test('passes a classification phrase with NO review-process reference', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// This is not a defect: umask always widens, never narrows, file permissions.',
  ]), 0);
});

test('passes an ordinary "regression test for round N" comment (no dismissal phrase)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Regression test for round 12 finding — proves the write happens after confinement.',
  ]), 0);
});

test('flags a review-round reference paired with a classification phrase on the SAME line', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// (round 13 finding, not a new independently-closable bug)',
  ]), 2);
});

test('flags the pattern spread across a multi-line comment BLOCK, all lines added', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// RESIDUAL WINDOW even with this ordering (round 13 finding, sharpening the same',
    '// already-documented ACL limitation, not independently closable): on a',
    '// filesystem where the CHOSEN DIRECTORY carries an inheritable ACL entry...',
  ]), 2);
});

test('does NOT bridge two separate comment blocks broken by a non-comment line', () => {
  assert.equal(run('lib/thing.mjs', [
    '// round 9 finding here',
    'const x = 1;',
    '// not a defect, unrelated comment',
  ], [1, 2, 3]), 0);
});

test('is flagged even inside a test file — a dismissive comment about an open finding is exactly as dangerous there (round-1 finding 0)', () => {
  assert.equal(runAllAdded('test/thing.test.mjs', [
    '// round 9 finding: not a defect, deferred as a follow-on',
  ]), 2);
});

test('is self-exempt for its own source file — its header necessarily quotes the pattern as documentation', () => {
  assert.equal(runAllAdded('scripts/check-reviewer-directed-comments.mjs', [
    '// (round 13 finding, not a new independently-closable bug) — a quoted historical example',
  ]), 0);
});

test('is self-exempt for its own test file — fixtures embed the literal pattern as test data', () => {
  assert.equal(runAllAdded('scripts/test/check-reviewer-directed-comments.test.mjs', [
    "  '// (round 13 finding, not a new independently-closable bug)',",
  ]), 0);
});

test('catches a violation split across UNCHANGED context and a newly ADDED line (round-1 finding 1, direction A)', () => {
  // Line 1 (the review-process reference) already existed before this change; only
  // line 2 (the classification phrase) is newly added to the same comment block.
  assert.equal(run('lib/thing.mjs', [
    '// round 9 finding: the mode check only covers POSIX bits',
    '// not a defect, this is expected on this filesystem',
  ], [2]), 2);
});

test('catches a violation split across UNCHANGED context and a newly ADDED line (round-1 finding 1, direction B)', () => {
  // Line 2 (the classification phrase) already existed; only line 1 (the review
  // reference) is newly added to the same comment block.
  assert.equal(run('lib/thing.mjs', [
    '// round 9 finding: adding this reference to an existing dismissal',
    '// not a defect, this is expected on this filesystem',
  ], [1]), 2);
});

test('does not flag a span where NEITHER half was touched by this diff', () => {
  assert.equal(run('lib/thing.mjs', [
    '// round 9 finding: not a defect, fully pre-existing, unrelated line changed below',
    'const untouched = 1;',
    'const changed = 2;',
  ], [3]), 0);
});

test('catches an INLINE trailing comment, not just line-start comments (round-1 finding 2)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    'const x = 1; // round 9 finding: not a defect, inline after code',
  ]), 2);
});

test('catches an unstarred /* ... */ block comment body line (round-1 finding 2)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '/* round 9 finding',
    '   not a defect, no leading star on this continuation line',
    '*/',
  ]), 2);
});

test('reports the exact file and starting line of a violation', () => {
  const deps = {
    resolveBase: () => 'origin/main',
    changedFiles: () => ['lib/thing.mjs'],
    gitDiff: () => buildDiff('lib/thing.mjs', [
      'const unrelated = 1;',
      '// round 5 finding: not independently closable',
    ], [1, 2]),
    readFile: () => 'const unrelated = 1;\n// round 5 finding: not independently closable',
  };
  const originalError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(msg);
  try {
    const code = check(undefined, deps);
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.includes('lib/thing.mjs:2')), `expected a line naming lib/thing.mjs:2, got: ${lines.join('\n')}`);
  } finally {
    console.error = originalError;
  }
});

test('exits 1 when the diff baseline cannot be resolved', () => {
  const deps = { resolveBase: () => null, changedFiles: () => [], gitDiff: () => '' };
  assert.equal(check(undefined, deps), 1);
});

test('exits 1 when computing the diff throws', () => {
  const deps = {
    resolveBase: () => 'origin/main',
    changedFiles: () => { throw new Error('git failed'); },
    gitDiff: () => '',
  };
  assert.equal(check(undefined, deps), 1);
});

test('a deleted file (unreadable at the diff head) is skipped, not an error', () => {
  const deps = {
    resolveBase: () => 'origin/main',
    changedFiles: () => ['gone.mjs'],
    gitDiff: () => buildDiff('gone.mjs', ['// round 9 finding: not a defect'], [1]),
    readFile: () => { throw new Error('ENOENT: no such file'); },
  };
  assert.equal(check(undefined, deps), 0);
});

test('an explicit base argument is used instead of calling resolveBase', () => {
  let resolveBaseCalled = false;
  const deps = {
    resolveBase: () => { resolveBaseCalled = true; return 'should-not-be-used'; },
    changedFiles: () => ['lib/thing.mjs'],
    gitDiff: () => buildDiff('lib/thing.mjs', ['// a clean comment'], [1]),
    readFile: () => '// a clean comment',
  };
  assert.equal(check('explicit-base', deps), 0);
  assert.equal(resolveBaseCalled, false, 'resolveBase must not be called when an explicit base is provided');
});
