// verify-citation-kind.test.mjs — what a citation resolves to, and which
// citations count as verified locations.
//
// A cited path must name a FILE at the revision. A directory resolves in git
// too (`cat-file -e` accepts a tree, `git show rev:dir` prints a listing), and
// an excerpt compared against a directory listing never matches, which reads
// as `fixed` — a close built from comparing code to a list of file names.
//
// And the issue-level verdict is not a per-location one: an issue can be
// `valid` because ONE citation still matches while another names a path that
// never existed. Only the citations that were themselves checked are verified
// locations.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyIssue, pathKindAtRevision } from '../lib/verify.mjs';

const SNIPPET = 'const answer = compute(input);';

function world(kinds, files = {}) {
  return {
    pathKind: (p) => kinds[p] ?? null,
    readFile: (p) => {
      if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[p];
    },
    lastCommitFor: () => 'abc1234',
    everExisted: (p) => p in kinds,
  };
}

const mechanical = (references) => ({ number: 7, route: 'mechanical', references });

test('a cited path that is a DIRECTORY at the revision is unverifiable, never fixed', () => {
  const io = world({ '.adlc/manifest.d': 'tree' }, { '.adlc/manifest.d': 'tree HEAD:.adlc/manifest.d\n\na.jsonl\n' });
  const v = verifyIssue(mechanical([{ path: '.adlc/manifest.d', line: null, snippet: SNIPPET }]), io);
  assert.equal(v.verdict, 'unverifiable');
  assert.match(v.reason, /not a file/);
});

test('a directory citation beside a gone snippet does not let the issue verify fixed', () => {
  const io = world(
    { 'lib/a.mjs': 'blob', 'lib/dir': 'tree' },
    { 'lib/a.mjs': 'something else\n', 'lib/dir': 'tree HEAD:lib/dir\n\nx.mjs\n' },
  );
  const v = verifyIssue(mechanical([
    { path: 'lib/a.mjs', line: 1, snippet: SNIPPET },
    { path: 'lib/dir', line: null, snippet: SNIPPET },
  ]), io);
  assert.equal(v.verdict, 'unverifiable');
});

test('a submodule (commit) citation is not a file either', () => {
  const v = verifyIssue(mechanical([{ path: 'vendor/sub', line: null, snippet: SNIPPET }]), world({ 'vendor/sub': 'commit' }));
  assert.equal(v.verdict, 'unverifiable');
});

test('a FILE citation still verifies as before', () => {
  const v = verifyIssue(
    mechanical([{ path: 'lib/a.mjs', line: 1, snippet: SNIPPET }]),
    world({ 'lib/a.mjs': 'blob' }, { 'lib/a.mjs': `${SNIPPET}\n` }),
  );
  assert.equal(v.verdict, 'valid');
});

test('pathKindAtRevision asks git for the object TYPE and reports it', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return 'tree\n'; };
  assert.equal(pathKindAtRevision('lib', 'abc', run), 'tree');
  assert.deepEqual(calls[0], ['git', 'cat-file', '-t', 'abc:lib']);
});

test('pathKindAtRevision is null when git has no such object', () => {
  const run = () => { throw Object.assign(new Error('fatal: path does not exist'), { status: 128 }); };
  assert.equal(pathKindAtRevision('nope.mjs', 'HEAD', run), null);
});

test('pathKindAtRevision against this repository: a tracked directory is a tree, a tracked file a blob', () => {
  // Real git, read-only, against paths this package itself ships.
  assert.equal(pathKindAtRevision('packages/backlog-groom/lib', 'HEAD'), 'tree');
  assert.equal(pathKindAtRevision('packages/backlog-groom/package.json', 'HEAD'), 'blob');
});

// ---- per-citation verified locations ---------------------------------------

test('verifiedPaths lists only the citations whose own check was valid or fixed', () => {
  const io = world(
    { 'packages/parallax/lib/modes.mjs': 'blob', 'scripts/foo.mjs': 'blob', 'packages/x/lib/gone.mjs': 'blob' },
    { 'packages/parallax/lib/modes.mjs': 'no excerpt here\n', 'scripts/foo.mjs': `${SNIPPET}\n`, 'packages/x/lib/gone.mjs': 'other\n' },
  );
  const v = verifyIssue(mechanical([
    { path: 'packages/parallax/lib/typo.mjs', line: 9, snippet: SNIPPET }, // never existed
    { path: 'packages/parallax/lib/modes.mjs', line: 3, snippets: [] }, // no excerpt
    { path: 'scripts/foo.mjs', line: 1, snippet: SNIPPET }, // valid
    { path: 'packages/x/lib/gone.mjs', line: 1, snippet: SNIPPET }, // fixed
  ]), io);
  assert.equal(v.verdict, 'valid');
  assert.deepEqual([...v.verifiedPaths].sort(), ['packages/x/lib/gone.mjs', 'scripts/foo.mjs']);
});

test('a moved or partial citation is not a verified location', () => {
  const io = world(
    { 'a.mjs': 'blob', 'b.mjs': 'blob' },
    { 'a.mjs': 'line one\n', 'b.mjs': `${SNIPPET}\n` },
  );
  const v = verifyIssue(mechanical([
    { path: 'a.mjs', line: 1, snippet: `line one\n${SNIPPET}` }, // partial
    { path: 'b.mjs', line: 1, snippet: SNIPPET },
  ]), io);
  assert.deepEqual(v.verifiedPaths, ['b.mjs']);

  const gone = verifyIssue(mechanical([{ path: 'c.mjs', line: 1, snippet: SNIPPET }]), {
    ...world({}), everExisted: () => true,
  });
  assert.equal(gone.verdict, 'moved');
  assert.deepEqual(gone.verifiedPaths, []);
});

test('the model and unverifiable routes carry no verified locations', () => {
  assert.deepEqual(verifyIssue({ number: 1, route: 'model', references: [] }, world({})).verifiedPaths, []);
  assert.deepEqual(verifyIssue({ number: 1, route: 'unverifiable', references: [] }, world({})).verifiedPaths, []);
});
