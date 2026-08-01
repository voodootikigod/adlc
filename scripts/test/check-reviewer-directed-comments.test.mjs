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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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
    gitDiff: (_base, f) => buildDiff(f, fullLines, addedLineNos),
    // No staged content in this fake fixture — explicit, not relying on a real `git`
    // call against a fake path happening to return nothing in the actual repo.
    gitDiffStaged: () => '',
    readFile: (f) => (f === file ? fullLines.join('\n') : (() => { throw new Error('ENOENT'); })()),
    readStagedFile: () => null,
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

test('flags the exact historical incident this gate documents: a "review status: closed" header (round-2 finding 2)', () => {
  assert.equal(runAllAdded('SPEC.md', [
    '## Review status: closed',
  ]), 2);
});

test('"review status" variants (resolved/done/passed/complete) are also flagged', () => {
  for (const verdict of ['resolved', 'done', 'passed', 'complete']) {
    assert.equal(runAllAdded('SPEC.md', [`Review status: ${verdict}`]), 2, `expected "${verdict}" to be flagged`);
  }
});

test('an ordinary, unrelated use of "fixed"/"closed" does NOT trigger the narrow status-assertion check', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Fixed the null-check bug; the ticket is now closed in our tracker.',
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

test('catches a violation whose text starts at column 0 of the CLOSING line of a block comment', () => {
  // The closing line's comment text must be captured in full, from its own start —
  // not off by one — and must still be classified as comment content, not dropped.
  assert.equal(runAllAdded('lib/thing.mjs', [
    '/* round 9 finding',
    'not a defect */',
  ]), 2);
});

test('a closed MULTI-LINE block comment does not leak into later unrelated content — two single-category phrases stay separate', () => {
  // The block spans TWO lines (opens on line 1, closes on line 2) so the `inBlock`
  // state machine is actually engaged — a single-line /* ... */ never touches it. If
  // the close were not correctly tracked, every remaining line in the file would be
  // wrongly folded into one giant open span, combining this review-reference with the
  // later, otherwise-unrelated classification phrase into a false violation.
  assert.equal(runAllAdded('lib/thing.mjs', [
    '/* round 9 finding, purely descriptive,',
    '   no classification word in this block */',
    'const untouched = 1;',
    '// not a defect, purely descriptive, no review reference here',
  ]), 0);
});

test('reports the exact file and starting line of a violation', () => {
  const deps = {
    resolveBase: () => 'origin/main',
    changedFiles: () => ['lib/thing.mjs'],
    gitDiff: () => buildDiff('lib/thing.mjs', [
      'const unrelated = 1;',
      '// round 5 finding: not independently closable',
    ], [1, 2]),
    gitDiffStaged: () => '',
    readFile: () => 'const unrelated = 1;\n// round 5 finding: not independently closable',
    readStagedFile: () => null,
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
    gitDiffStaged: () => '',
    readFile: () => { throw new Error('ENOENT: no such file'); },
    readStagedFile: () => null,
  };
  assert.equal(check(undefined, deps), 0);
});

test('an explicit base argument is used instead of calling resolveBase', () => {
  let resolveBaseCalled = false;
  const deps = {
    resolveBase: () => { resolveBaseCalled = true; return 'should-not-be-used'; },
    changedFiles: () => ['lib/thing.mjs'],
    gitDiff: () => buildDiff('lib/thing.mjs', ['// a clean comment'], [1]),
    gitDiffStaged: () => '',
    readFile: () => '// a clean comment',
    readStagedFile: () => null,
  };
  assert.equal(check('explicit-base', deps), 0);
  assert.equal(resolveBaseCalled, false, 'resolveBase must not be called when an explicit base is provided');
});

test('REAL git diff: an added `++ counter;` line does not hide a later violation in the same file (round-2 finding 1, real git, not a mocked fixture)', () => {
  // A mocked unified-diff fixture cannot validate this: the exact byte shape of
  // `+++ counter;` in a real patch depends on git's own diff generation, not on
  // whatever shape a hand-built fixture assumes. This drives the real `git` binary.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-real-git-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'add context'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n++ counter;\n// round 9 finding: not a defect\n');

    const code = check('HEAD', {
      changedFiles: () => ['thing.mjs'],
      gitDiff: () => execFileSync('git', ['diff', 'HEAD', '--', 'thing.mjs'], { cwd: repo, encoding: 'utf8' }),
      gitDiffStaged: () => '',
      readFile: (file) => readFileSync(join(repo, file), 'utf8'),
      readStagedFile: () => null,
    });
    assert.equal(code, 2, 'the violation must still be caught even though it follows a `++ counter;` added line in the same file');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REAL git diff: a filename containing a space keeps its added-line coverage (round-3 finding: whitespace/quoted filenames)', () => {
  // git appends a trailing TAB to a space-bearing name in the +++ header (verified
  // against real git output), which would desync a header-text-based file match.
  // Diffing this path individually — the production gitDiffForFile contract — means
  // that header text is never consulted for file identity, only line numbers.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-space-name-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'review notes.md'), 'context\n');
    execFileSync('git', ['add', 'review notes.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'add context'], { cwd: repo });
    writeFileSync(join(repo, 'review notes.md'), 'context\nReview status: closed\n');

    const code = check('HEAD', {
      changedFiles: () => ['review notes.md'],
      readFile: (file) => readFileSync(join(repo, file), 'utf8'),
      gitDiff: (base, file) => execFileSync('git', ['diff', base, '--', file], { cwd: repo, encoding: 'utf8' }),
      gitDiffStaged: () => '',
      readStagedFile: () => null,
    });
    assert.equal(code, 2, 'the violation in a space-bearing filename must still be caught');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the real default gitDiffForFile (not injected) scopes to one file — an added line in another TRACKED file does not leak into this file\'s added-line set', () => {
  // Exercises the actual production default (no gitDiff override), unlike every
  // other test in this file. Proves two things at once: the default does not crash
  // (it returns real diff text, not null), and it is genuinely scoped per file — if
  // it silently diffed the whole repo instead, b.mjs's harmless added lines would
  // merge into a.mjs's added-line set (parseAddedLines' line numbers are taken
  // without regard to which file's hunk they came from) and wrongly flag a.mjs's
  // PRE-EXISTING (untouched) violation, which sits on the same line number.
  // Both files must be TRACKED at the base commit and then modified — an
  // untracked file never appears in `git diff HEAD` at all (scoped or not), which
  // would make a scoped and an unscoped diff indistinguishable here.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-default-scope-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'context\n// round 9 finding: not a defect\n');
    writeFileSync(join(repo, 'b.mjs'), 'unrelated\n');
    execFileSync('git', ['add', 'a.mjs', 'b.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'add a (pre-existing violation) and b'], { cwd: repo });

    // Feature side: a.mjs only gets a new trailing line (its line-2 violation is
    // untouched). b.mjs gets two new lines inserted at the top, so ITS OWN added
    // lines land at 1 and 2 — line 2 numerically coincides with a.mjs's untouched
    // violation.
    writeFileSync(join(repo, 'a.mjs'), 'context\n// round 9 finding: not a defect\nmore context\n');
    writeFileSync(join(repo, 'b.mjs'), 'filler1\nfiller2\nunrelated\n');

    process.chdir(repo);
    const code = check('HEAD', {
      changedFiles: () => ['a.mjs', 'b.mjs'],
      readFile: (file) => readFileSync(join(repo, file), 'utf8'),
      gitDiffStaged: () => '',
      readStagedFile: () => null,
    });
    assert.equal(code, 0, "a.mjs's untouched violation must not be flagged due to b.mjs's unrelated added line 2");
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('catches a violation split by a closed block comment followed by a trailing line comment on the same line (round-3 finding 2)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '/* factual */ // round 9 finding: not a defect',
  ]), 2);
});

test('a closed block comment followed by ordinary trailing code (no line comment) is unaffected', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '/* round 9 finding: not a defect */ const x = 1;',
  ]), 2);
});

test('recognizes a bare numeric finding reference without "#" or "id" (round-3 finding 3)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// finding 9: not a defect',
  ]), 2);
});

test('the word "finding" used ordinarily, with no classification phrase nearby, still passes', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// we are finding 3 bugs a week in this module',
  ]), 0);
});

test('catches two adjacent block comments on the same line, each carrying half the pattern (round-4 finding 2)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '/* round 9 finding */ /* not a defect */',
  ]), 2);
});

test('a .mdc Cursor rule file is scanned as prose, like .md (round-4 finding 1)', () => {
  assert.equal(runAllAdded('plugins/adlc-cursor/rules/adlc.mdc', [
    'Round 9 finding: not a defect',
  ]), 2);
});

test('REAL git diff: deleting the line between two pre-existing comment runs merges them into one flagged span, with zero added lines (round-4 finding 3)', () => {
  // A deletion-only patch: the diff has no `+` lines at all, so tracking added
  // lines alone would skip this file entirely. The merge itself — not any single
  // added line — is what makes the combined span authority-smuggling.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-deletion-merge-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), '// round 9 finding\nconst separator = 1;\n// not a defect\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), '// round 9 finding\n// not a defect\n');

    const code = check('HEAD', {
      changedFiles: () => ['thing.mjs'],
      gitDiff: (base, file) => execFileSync('git', ['diff', base, '--', file], { cwd: repo, encoding: 'utf8' }),
      gitDiffStaged: () => '',
      readFile: (file) => readFileSync(join(repo, file), 'utf8'),
      readStagedFile: () => null,
    });
    assert.equal(code, 2, 'the merged span created purely by a deletion must still be caught');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a deletion that does NOT merge two comment runs (they stay separated by other code) does not falsely flag', () => {
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-deletion-nomerge-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), '// round 9 finding\nconst separator = 1;\nconst other = 2;\n// not a defect\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), '// round 9 finding\nconst other = 2;\n// not a defect\n');

    const code = check('HEAD', {
      changedFiles: () => ['thing.mjs'],
      gitDiff: (base, file) => execFileSync('git', ['diff', base, '--', file], { cwd: repo, encoding: 'utf8' }),
      gitDiffStaged: () => '',
      readFile: (file) => readFileSync(join(repo, file), 'utf8'),
      readStagedFile: () => null,
    });
    assert.equal(code, 0, "const other = 2; still separates the two comments post-change, so they must stay two spans, neither containing both halves");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a hunk header that OVER-declares its line count does not pollute a later file\'s touched-line set (the diff --git hard reset, not the count check, closes it)', () => {
  // gitDiffForFile never actually produces multi-`diff --git`-section output (it
  // scopes to one path), but touchedLineNumbers is written to handle it defensively.
  // The first (other.mjs) hunk claims 5 new lines but only 2 follow before the next
  // `diff --git` line — a lying header the count-based closing check alone can never
  // close. Without the hard reset, the following `--- `/`+++ ` header lines get
  // misread as hunk body content (the `+++` line starts with `+`, so it is read as
  // an ADDED line), spuriously marking a wrong line number as touched — landing,
  // in this fixture, exactly on thing.mjs's own PRE-EXISTING (untouched) violation.
  const diff = `diff --git a/other.mjs b/other.mjs
--- a/other.mjs
+++ b/other.mjs
@@ -1 +1,5 @@
 unchanged
+added in other
diff --git a/thing.mjs b/thing.mjs
--- a/thing.mjs
+++ b/thing.mjs
@@ -4,1 +4,2 @@
 context4
+harmless added line
`;
  const content = [
    'context1',
    'context2',
    '// round 9 finding: not a defect',
    'context4',
    'harmless added line',
  ].join('\n');

  const code = check('HEAD', {
    changedFiles: () => ['thing.mjs'],
    gitDiff: () => diff,
    gitDiffStaged: () => '',
    readFile: () => content,
    readStagedFile: () => null,
  });
  assert.equal(code, 0, "thing.mjs's pre-existing violation on line 3 must stay untouched — only line 5 was actually added");
});

test('a hunk whose declared count is exhausted exactly at 0/0 closes via the count check alone, with NO diff --git line at all', () => {
  // Same fixture and reasoning as the "lying hunk header" test above, except
  // other.mjs's hunk this time declares its ACTUAL body length (no lie) and there
  // is no `diff --git` line anywhere — isolating the count-based closing check as
  // the only mechanism available to transition between the two header/hunk
  // sections. Without it correctly firing at exactly old=0,new=0 (not off-by-one,
  // not "never"), thing.mjs's `+++` header is misread as an added line the same
  // way, polluting the touched set onto its pre-existing violation at line 3.
  const diff = `--- a/other.mjs
+++ b/other.mjs
@@ -1 +1,2 @@
 unchanged
+added in other
--- a/thing.mjs
+++ b/thing.mjs
@@ -4,1 +4,2 @@
 context4
+harmless added line
`;
  const content = [
    'context1',
    'context2',
    '// round 9 finding: not a defect',
    'context4',
    'harmless added line',
  ].join('\n');

  const code = check('HEAD', {
    changedFiles: () => ['thing.mjs'],
    gitDiff: () => diff,
    gitDiffStaged: () => '',
    readFile: () => content,
    readStagedFile: () => null,
  });
  assert.equal(code, 0, "thing.mjs's pre-existing violation on line 3 must stay untouched even with no diff --git separator anywhere");
});

test('catches a single-line HTML/XML comment (.svg/.tsx/.html content, round-5 finding)', () => {
  assert.equal(runAllAdded('assets/logo.svg', [
    '<!-- round 9 finding: not a defect -->',
  ]), 2);
});

test('catches a multi-line HTML/XML comment', () => {
  assert.equal(runAllAdded('assets/logo.svg', [
    '<!-- round 9 finding',
    '     not a defect -->',
  ]), 2);
});

test('an HTML comment followed by a trailing line comment on the same line is still fully captured', () => {
  assert.equal(runAllAdded('app/page.tsx', [
    '<!-- round 9 finding --> // not a defect',
  ]), 2);
});

test('an ordinary HTML comment with no trigger phrase passes', () => {
  assert.equal(runAllAdded('assets/logo.svg', [
    '<!-- decorative icon, no functional purpose -->',
  ]), 0);
});

test('REAL git diff: a violation staged and then reverted in the working tree is still caught (round-5 finding 3, local preflight blind spot)', () => {
  // The exact scenario from the finding: a plain `git diff base -- file` (worktree
  // vs base) never consults the index. Staging a violation and then reverting the
  // working tree copy back to base makes the worktree diff empty, yet `git commit`
  // (no -a) would record the staged content. Uses the REAL default gitDiffForFile /
  // gitDiffForFileStaged / readStagedFile (none injected) via process.chdir, so this
  // exercises the actual production defaults, not a mock standing in for them.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-staged-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(join(repo, 'thing.mjs'), 'context\n// round 9 finding: not a defect\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n'); // revert the WORKING TREE only

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['thing.mjs'] });
    assert.equal(code, 2, 'the staged (about-to-be-committed) violation must be caught even though the worktree copy was reverted');
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REAL git diff: an unstaged, in-progress edit with no violation does not false-positive against a clean staged version', () => {
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-staged-clean-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(join(repo, 'thing.mjs'), 'context\nharmless addition\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['thing.mjs'] });
    assert.equal(code, 0);
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REAL git diff: a genuine UNSTAGED violation is still caught via the real default gitDiffForFile (nothing injected at all)', () => {
  // Every other test in this file injects at least gitDiff. This one injects
  // NOTHING — changedFiles, gitDiff, gitDiffStaged, readFile, and readStagedFile all
  // resolve to their real production defaults — proving gitDiffForFile's default
  // does not silently swallow a genuine worktree-only violation (e.g. by returning
  // null instead of real diff text, which check()'s catch around the worktree scan
  // would otherwise absorb as if the file were merely deleted/unreadable).
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-real-default-worktree-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(join(repo, 'thing.mjs'), 'context\n// round 9 finding: not a defect\n');

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['thing.mjs'] });
    assert.equal(code, 2, 'an unstaged worktree violation must still be caught with every dependency at its real default');
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REAL git diff: staged-diff scoping does not leak another file\'s staged addition onto an untouched pre-existing violation', () => {
  // Mirrors the worktree-side "leak into this file" test, but for the STAGED path:
  // a.mjs has a pre-existing violation on line 2 and is otherwise untouched (neither
  // staged nor in the working tree); b.mjs gets a new line STAGED at line 2. If
  // gitDiffForFileStaged dropped its --file scoping (returning a whole-repo staged
  // diff regardless of which file it was asked for), b.mjs's added line 2 would
  // leak into a.mjs's touched-line set and wrongly flag a.mjs's untouched violation.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-staged-scope-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'a.mjs'), 'context\n// round 9 finding: not a defect\n');
    writeFileSync(join(repo, 'b.mjs'), 'line0\nunrelated\n');
    execFileSync('git', ['add', 'a.mjs', 'b.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'add a (pre-existing violation) and b'], { cwd: repo });

    // a.mjs stays fully untouched. b.mjs gets a line STAGED at position 2.
    writeFileSync(join(repo, 'b.mjs'), 'line0\nadded staged\nunrelated\n');
    execFileSync('git', ['add', 'b.mjs'], { cwd: repo });

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['a.mjs', 'b.mjs'] });
    assert.equal(code, 0, "a.mjs's untouched violation must not be flagged due to b.mjs's unrelated staged line 2");
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REAL git diff: a .gitattributes `binary` rule does not hide a textual violation (round-6 finding 1)', () => {
  // A `.gitattributes` rule marking a path `binary` (author-controlled, not a trust
  // root) makes a plain `git diff` emit "Binary files ... differ" with no `@@`
  // hunks. Without forcing a textual diff, touchedLineNumbers sees nothing and the
  // file is silently unscanned regardless of its real content.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-binary-attr-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'target.mjs'), 'context\n');
    execFileSync('git', ['add', 'target.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(join(repo, '.gitattributes'), 'target.mjs binary\n');
    writeFileSync(join(repo, 'target.mjs'), 'context\n// round 9 finding: not a defect\n');

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['target.mjs'] });
    assert.equal(code, 2, 'a .gitattributes binary rule must not hide a real textual violation');
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('recognizes "review" (not just "reviewer") followed by "found"/"flagged" (round-6 finding 2)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Review found this; not a defect',
  ]), 2);
});

test('"reviewer flagged" still matches (regression: the review(?:er)? fix must not narrow the existing reviewer case)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Reviewer flagged this; not a defect',
  ]), 2);
});

test('recognizes "false positive" as a classification phrase (round-6 finding 2)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Round 3 review: false positive',
  ]), 2);
});

test('recognizes "cleared to proceed" as a classification phrase (round-6 finding 2)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Post adversarial review round 3 — cleared to proceed',
  ]), 2);
});

test('recognizes "review status" with light Markdown emphasis around the verdict word (round-6 finding 2)', () => {
  assert.equal(runAllAdded('SPEC.md', [
    '## Review status: **closed**',
  ]), 2);
});

test('REAL git diff: a repo-local textconv filter that strips the violation from diff display does not hide it (--no-textconv)', () => {
  // A `.gitattributes` diff driver + repo-local `diff.<driver>.textconv` config
  // (both author-controlled, not trust roots) can transform what a plain `git diff`
  // shows. Here the textconv strips the violating line, making the transformed old
  // and new sides IDENTICAL — a plain `git diff --text` (no --no-textconv) shows
  // NOTHING AT ALL for this file, not just a redacted line. --no-textconv forces the
  // real, untransformed content.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-textconv-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'target.mjs'), 'context\n');
    execFileSync('git', ['add', 'target.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(join(repo, '.gitattributes'), 'target.mjs diff=stripviolation\n');
    execFileSync('git', ['config', 'diff.stripviolation.textconv', "sed '/not a defect/d'"], { cwd: repo });
    writeFileSync(join(repo, 'target.mjs'), 'context\n// round 9 finding: not a defect\n');

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['target.mjs'] });
    assert.equal(code, 2, 'a repo-local textconv filter must not hide a real textual violation');
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REAL git diff: a filename that is itself git pathspec magic syntax is diffed literally, not interpreted (round-7 finding 1)', () => {
  // `--` ends OPTION parsing but does not disable PATHSPEC MAGIC: a tracked file
  // literally named `:(literal)notes.md` is otherwise read as magic syntax by
  // `git diff -- <file>`, silently diffing the unrelated (and here nonexistent)
  // path `notes.md` instead — verified directly: without --literal-pathspecs this
  // reproduction diffs nothing and the real violation goes uncaught.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-pathspec-magic-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    const magicName = ':(literal)notes.md';
    writeFileSync(join(repo, magicName), 'context\n');
    execFileSync('git', ['--literal-pathspecs', 'add', magicName], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(join(repo, magicName), 'context\nReview status: closed\n');

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => [magicName] });
    assert.equal(code, 2, 'a pathspec-magic filename must still be diffed literally and its violation caught');
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('recognizes "invalid", "dismissed", "non-issue", "accepted risk", and "do not report/reopen" (round-8 finding 2)', () => {
  for (const phrase of [
    'Round 9 finding: invalid; do not report this again.',
    'Round 9 finding: dismissed.',
    'Round 9 finding: non-issue.',
    'Round 9 finding: accepted risk.',
    'Round 9 finding: do not reopen.',
  ]) {
    assert.equal(runAllAdded('lib/thing.mjs', [`// ${phrase}`]), 2, `expected "${phrase}" to be flagged`);
  }
});

test('REAL git diff: an edit in one paragraph of a prose file is not blocked by review/dismissal terminology in an unrelated, distant paragraph (round-8 finding 3)', () => {
  // Before this fix, treatEveryLineAsComment marked every line — including blank
  // ones — as a comment, so commentSpans (which splits a run wherever isComment is
  // false) produced exactly ONE span for the whole document. An edit anywhere then
  // combined text from every paragraph, including "round 9 finding" in one
  // section and "false positives" in an entirely unrelated one.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-prose-paragraph-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    const base = [
      '# History',
      '',
      'This project had a round 9 finding once.',
      '',
      '# Unrelated section',
      '',
      'We are reducing false positives in general.',
      '',
    ].join('\n');
    writeFileSync(join(repo, 'doc.md'), base);
    execFileSync('git', ['add', 'doc.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(join(repo, 'doc.md'), `${base}\n# New section\nHarmless addition.\n`);

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['doc.md'] });
    assert.equal(code, 0, "an edit in a new, unrelated paragraph must not combine with distant sections' terminology");
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a genuine violation split across the SAME paragraph is still caught after paragraph segmentation', () => {
  assert.equal(runAllAdded('SPEC.md', [
    'Some intro text.',
    '',
    'Round 9 finding: not a defect, same paragraph.',
    'Still the same paragraph.',
  ]), 2);
});

test('REAL git diff: a string literal containing an unclosed-looking `/*` does not merge distant, unrelated comments into one giant span (self-discovered while fixing round-8 finding 2/3)', () => {
  // A glob-pattern string like 'src/critical/**' or a gitignore pattern like
  // '.adlc/*\n...' contains `/*` with no real closing `*/` anywhere nearby.
  // Before bounding the block-open lookahead, this opened a "block comment" that
  // scanned forward until ANY `*/` eventually turned up — potentially the rest of
  // the file — silently merging every comment in between into one span. Here a
  // review-reference near the top and an unrelated dismissal phrase 50+ lines
  // later must stay in separate, unmerged spans.
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-false-block-open-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });

    const lines = [
      "const rails = 'src/critical/**'; // an ordinary glob pattern, not a comment",
      '// round 9 finding: a historical reference, standalone, no dismissal here',
    ];
    for (let i = 0; i < 50; i++) lines.push(`const filler${i} = ${i};`);
    lines.push('// unrelated: not a defect, a wholly separate standalone comment');
    const content = `${lines.join('\n')}\n`;

    writeFileSync(join(repo, 'thing.mjs'), content);
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });

    writeFileSync(repo + '/thing.mjs', `${content}const harmless = true;\n`);

    process.chdir(repo);
    const code = check('HEAD', { changedFiles: () => ['thing.mjs'] });
    assert.equal(code, 0, 'the review-reference near the top and the dismissal phrase 50+ lines later must not merge into one false violation');
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a block comment longer than the old 40-line cutoff still catches a violation (round-9 finding 3)', () => {
  // The 40-line lookahead bound tried in an earlier round was a deterministic
  // bypass: pad a real violation inside a genuinely long comment and it went
  // unscanned. Replaced with quote-literal tracking (no length limit at all) —
  // this proves a 50-line real block comment is still fully scanned.
  const filler = Array.from({ length: 48 }, (_, i) => ` * filler line ${i}`);
  assert.equal(runAllAdded('lib/thing.mjs', [
    '/**',
    ...filler,
    ' * round 9 finding: not a defect',
    ' */',
  ]), 2);
});

test('REAL CLI: the direct-execution guard runs the gate when invoked from a path containing a space (round-9 finding 4)', () => {
  // `import.meta.url === \`file://${process.argv[1]}\`` silently never matches
  // when the SCRIPT's own path needs URL-encoding (a space becomes %20 in the URL
  // but stays a literal space in argv[1]) — the script exits 0 having never run
  // check() at all. The script copy must stay nested under this repo (not an
  // unrelated temp dir) so its own `@adlc/core` import still resolves via the
  // real node_modules — only its own path needs the space, not the git repo it
  // scans, so a separate temp git repo (via --cwd) supplies that.
  const testDir = dirname(fileURLToPath(import.meta.url));
  const spacedDir = join(testDir, 'adlc cli space test dir');
  const repo = mkdtempSync(join(tmpdir(), 'adlc-check-reviewer-directed-cli-space-'));
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n');
    execFileSync('git', ['add', 'thing.mjs'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'base'], { cwd: repo });
    writeFileSync(join(repo, 'thing.mjs'), 'context\n// round 9 finding: not a defect\n');

    mkdirSync(spacedDir, { recursive: true });
    const scriptSrc = readFileSync(new URL('../check-reviewer-directed-comments.mjs', import.meta.url), 'utf8');
    const scriptCopy = join(spacedDir, 'check-reviewer-directed-comments.mjs');
    writeFileSync(scriptCopy, scriptSrc);

    let status = 0;
    try {
      execFileSync(process.execPath, [scriptCopy, 'HEAD'], { cwd: repo, stdio: 'pipe' });
    } catch (e) {
      status = e.status ?? 1;
    }
    assert.equal(status, 2, 'the CLI must actually run check() and detect the violation even from a spaced path');
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
    rmSync(spacedDir, { recursive: true, force: true });
  }
});

test('recognizes "out of scope", "safe to ignore", "works as intended", and "disregard it" (round-10 finding 3)', () => {
  for (const phrase of [
    'Round 9 finding is out of scope; disregard it.',
    'Round 9 finding: safe to ignore.',
    'Round 9 finding: works as intended.',
  ]) {
    assert.equal(runAllAdded('lib/thing.mjs', [`// ${phrase}`]), 2, `expected "${phrase}" to be flagged`);
  }
});

test('a real block comment on the SAME line as a regex literal containing a quote character is still caught (round-10 finding 4)', () => {
  // /'/  is a regex literal matching an apostrophe — its single quote character
  // would otherwise desync the quote-balance scan for the REST OF THE SAME LINE,
  // making the block-comment opener right after it look like it's still inside a
  // string and get silently excluded (a false negative — missing a real
  // violation, the dangerous direction). The scan resets per line, so this only
  // reproduces when both are on the same line, matching the real finding.
  assert.equal(runAllAdded('lib/thing.mjs', [
    "const apostrophe = /'/; /* round 9 finding: not a defect */",
  ]), 2);
});

test('a regex literal on the same line as a REAL trailing line comment does not desync detection (negative control)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    "const apostrophe = /'/; // round 9 finding: not a defect, but on a REAL line comment",
  ]), 2);
});

test('an ordinary division expression is not misread as a regex literal', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    'const half = total / 2; // round 9 finding: not a defect',
  ]), 2);
});

test('recognizes "harmless" and "leave this/it closed" (round-11 finding 4)', () => {
  for (const phrase of [
    'Round 9 finding: harmless; leave this closed.',
    'Round 9 finding: harmless.',
    'Review found this, but it is harmless; leave it closed.',
  ]) {
    assert.equal(runAllAdded('lib/thing.mjs', [`// ${phrase}`]), 2, `expected "${phrase}" to be flagged`);
  }
});

test('recognizes "acceptable", "informational only", "approved exception", and "should remain closed" (round-12 finding 3)', () => {
  for (const phrase of [
    'Round 9 finding: acceptable; future audits should leave it closed.',
    'Round 9 finding: informational only.',
    'Round 9 finding: approved exception.',
    'Round 9 finding: should remain closed.',
  ]) {
    assert.equal(runAllAdded('lib/thing.mjs', [`// ${phrase}`]), 2, `expected "${phrase}" to be flagged`);
  }
});

test('catches a real block comment inside a template-literal `${...}` interpolation (round-12 finding 4)', () => {
  // `${...}` is real JS expression context, not string content — a comment
  // inside it is real. Without tracking interpolation, the opening backtick
  // makes the quote-balance scan treat everything after it (including the
  // interpolation) as string content, silently excluding a real block comment.
  assert.equal(runAllAdded('lib/thing.mjs', [
    'const x = `${value /* round 9 finding: not a defect */}`;',
  ]), 2);
});

test('a nested object literal inside a template interpolation does not end the interpolation early, so template-literal state resyncs correctly afterward', () => {
  // `{ a: 1 }` is a nested brace pair inside the interpolation, not the end of
  // it — without depth tracking, seeing its `}` would wrongly end interpolation
  // mode one brace early, leaving the SAME line's quote-tracking desynced for
  // everything after (here, a real comment following the whole template literal).
  assert.equal(runAllAdded('lib/thing.mjs', [
    'const x = `${fn({ a: 1 })}`; /* round 9 finding: not a defect */',
  ]), 2);
});

test('an ordinary template literal with no interpolation is still treated as a string (negative control)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    'const glob = `src/critical/**`; /* round 9 finding: not a defect */',
  ]), 2);
});

test('recognizes "review concluded" and "benign"/"no change is warranted" (round-13 finding 3)', () => {
  for (const phrase of [
    'Prior review concluded this concern is acceptable.',
    'Round 9 finding: benign; no change is warranted.',
  ]) {
    assert.equal(runAllAdded('lib/thing.mjs', [`// ${phrase}`]), 2, `expected "${phrase}" to be flagged`);
  }
});

test('recognizes "unfounded" and "requires no remediation" (round-14 finding 4)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Round 9 finding: this objection is unfounded and requires no remediation.',
  ]), 2);
});

test('a regex literal after the "throw" keyword does not desync detection (round-14 finding 3a)', () => {
  // "throw" was missing from REGEX_LITERAL's keyword set, so `throw /'/;` was not
  // recognized as opening a regex literal — its quote character then desynced the
  // scan for the rest of the line, hiding the real block comment right after it.
  assert.equal(runAllAdded('lib/thing.mjs', [
    "throw /'/; /* Round 9 finding: not a defect */",
  ]), 2);
});

test('a nested string containing a literal `}` inside a template interpolation does not end the interpolation early (round-14 finding 3b)', () => {
  // fn("}")'s nested string contains a literal `}` that is NOT the interpolation's
  // own closing brace. Without tracking a nested quote inside `${...}`, that `}`
  // was miscounted as ending the interpolation, leaving the real comment that
  // follows (still inside the interpolation, before its true closing `}`)
  // misclassified as ordinary backtick-string content.
  assert.equal(runAllAdded('lib/thing.mjs', [
    '`${fn("}") /* round 9 finding: not a defect */}`;',
  ]), 2);
});

test('a regex literal after the "await" keyword does not desync detection (round-15 finding 3)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    'const x = await /"/; /* Round 9 finding: not a defect */',
  ]), 2);
});

test('recognizes "no fix is necessary" (round-15 finding 4)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Round 9 finding: no fix is necessary.',
  ]), 2);
});

test('a regex literal after "export default" does not desync detection (round-16 finding 4)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    "export default /'/; /* Round 9 finding: not a defect */",
  ]), 2);
});

test('recognizes "remediation should be declined" (round-16 finding 3)', () => {
  assert.equal(runAllAdded('lib/thing.mjs', [
    '// Round 9 finding: any remediation should be declined.',
  ]), 2);
});
