// The lint gate for authority-smuggling comments: a source comment that references
// this project's OWN review process (a round number, a finding id) alongside a
// classification/dismissal phrase ("not a defect", "not independently closable") is
// flagged. This pattern recurred three times before this gate existed, each time
// caught only by a live adversarial-review pass rather than a deterministic check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../check-reviewer-directed-comments.mjs';

function unifiedDiff(file, addedLines) {
  const hunk = addedLines.map((l) => `+${l}`).join('\n');
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,${addedLines.length + 1} @@\n context\n${hunk}\n`;
}

function run(file, addedLines) {
  const deps = {
    resolveBase: () => 'origin/main',
    changedFiles: () => [file],
    gitDiff: () => unifiedDiff(file, addedLines),
  };
  return check(undefined, deps);
}

test('passes a normal, factual comment with no review-process reference', () => {
  assert.equal(run('lib/thing.mjs', [
    '// This is a residual limitation: the check cannot close a concurrent rename',
    '// window because Node has no fd-relative open primitive.',
  ]), 0);
});

test('passes a review-process reference with NO classification phrase', () => {
  assert.equal(run('lib/thing.mjs', [
    '// Fixed in round 8: the write now happens after confinement, not before.',
  ]), 0);
});

test('passes a classification phrase with NO review-process reference', () => {
  assert.equal(run('lib/thing.mjs', [
    '// This is not a defect: umask always widens, never narrows, file permissions.',
  ]), 0);
});

test('flags a review-round reference paired with a classification phrase on the SAME line', () => {
  assert.equal(run('lib/thing.mjs', [
    '// (round 13 finding, not a new independently-closable bug)',
  ]), 2);
});

test('flags the pattern spread across a multi-line comment BLOCK', () => {
  assert.equal(run('lib/thing.mjs', [
    '// RESIDUAL WINDOW even with this ordering (round 13 finding, sharpening the same',
    '// already-documented ACL limitation, not a new independently-closable bug): on a',
    '// filesystem where the CHOSEN DIRECTORY carries an inheritable ACL entry...',
  ]), 2);
});

test('does NOT bridge two separate comment blocks broken by a non-comment line', () => {
  assert.equal(run('lib/thing.mjs', [
    '// round 9 finding here',
    'const x = 1;',
    '// not a defect, unrelated comment',
  ]), 0);
});

test('is self-exempt for its own source file — its header necessarily quotes the pattern as documentation', () => {
  assert.equal(run('scripts/check-reviewer-directed-comments.mjs', [
    '// (round 13 finding, not a new independently-closable bug) — a quoted historical example',
  ]), 0);
});

test('is exempt for a test file — "regression test for round N" is normal test documentation', () => {
  assert.equal(run('test/thing.test.mjs', [
    '// Regression test for round 12 finding — this is not a new bug, already fixed and verified.',
  ]), 0);
});

test('reports the exact file and starting line of a violation', () => {
  const deps = {
    resolveBase: () => 'origin/main',
    changedFiles: () => ['lib/thing.mjs'],
    gitDiff: () => unifiedDiff('lib/thing.mjs', [
      'const unrelated = 1;',
      '// round 5 finding: not independently closable',
    ]),
  };
  const originalError = console.error;
  const lines = [];
  console.error = (msg) => lines.push(msg);
  try {
    const code = check(undefined, deps);
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.includes('lib/thing.mjs:3')), `expected a line naming lib/thing.mjs:3, got: ${lines.join('\n')}`);
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

test('an explicit base argument is used instead of calling resolveBase', () => {
  let resolveBaseCalled = false;
  const deps = {
    resolveBase: () => { resolveBaseCalled = true; return 'should-not-be-used'; },
    changedFiles: () => ['lib/thing.mjs'],
    gitDiff: () => unifiedDiff('lib/thing.mjs', ['// a clean comment']),
  };
  assert.equal(check('explicit-base', deps), 0);
  assert.equal(resolveBaseCalled, false, 'resolveBase must not be called when an explicit base is provided');
});
