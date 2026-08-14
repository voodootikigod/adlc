// CODEOWNERS parsing shared by the two questions the gate asks (#140).
//
// The two CI steps used to carry their own parsers with slightly different comment and
// glob rules. They share one now, so the rules are pinned here rather than rediscovered
// per caller. Resolution (GitHub precedence for coverage, union for ownership) is covered
// end-to-end by the bootstrap and #141 suites; this file pins the parse itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEOWNERS_FILES, parseCodeowners } from '../lib/ci/codeowners.mjs';

test('GitHub file precedence order is preserved', () => {
  assert.deepEqual(CODEOWNERS_FILES, ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
});

test('owners are captured with the @ stripped, in file order', () => {
  const rows = parseCodeowners('*.mjs @alice @bob\ndocs/ @carol\n');
  assert.deepEqual(rows.map((r) => r.pattern), ['*.mjs', 'docs/']);
  assert.deepEqual(rows[0].owners, ['alice', 'bob']);
  assert.deepEqual(rows[1].owners, ['carol']);
});

test('a negated pattern is flagged rather than dropped', () => {
  // Dropping it would be a fail-OPEN: a negation that un-owns a path must still be seen,
  // so last-match-wins resolution can act on it.
  const [row] = parseCodeowners('!.github/workflows/adlc-rails-guard.yml @alice\n');
  assert.equal(row.negated, true);
  assert.equal(row.pattern, '.github/workflows/adlc-rails-guard.yml');
});

test('a pattern with NO owners is kept, so it can un-own an earlier match', () => {
  const rows = parseCodeowners('* @alice\n.github/workflows/adlc-rails-guard.yml\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].owners, []);
});

test('full-line and trailing comments are stripped', () => {
  const rows = parseCodeowners('# a comment\n*.mjs @alice # trailing note\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].owners, ['alice']);
});

// A comment marker only starts a comment at the line start or after whitespace. Treating
// every `#` as a comment would silently truncate a pattern that legitimately contains one.
test('a # inside a pattern does not start a comment', () => {
  const [row] = parseCodeowners('docs/c#sharp/** @alice\n');
  assert.equal(row.pattern, 'docs/c#sharp/**');
  assert.deepEqual(row.owners, ['alice']);
});

test('blank lines and CRLF endings are handled', () => {
  const rows = parseCodeowners('\r\n*.mjs @alice\r\n\r\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].owners, ['alice']);
});

test('empty input yields no rows rather than throwing', () => {
  assert.deepEqual(parseCodeowners(''), []);
});

// ---------------------------------------------------------------------------------
// #363 round 3. Owner RESOLUTION had two over-grants, both of which could hand the #141
// ceremony an approver GitHub would not recognise. Both directions are now conservative.

import { ownersForPaths, pathHasCodeowner } from '../lib/ci/codeowners.mjs';

// A tiny fake git: returns the named CODEOWNERS blobs, non-zero for anything absent.
function fakeGit(files) {
  return (args) => {
    const spec = args[1] ?? '';
    const path = spec.slice(spec.indexOf(':') + 1);
    return Object.prototype.hasOwnProperty.call(files, path)
      ? { status: 0, stdout: files[path] }
      : { status: 1, stdout: '' };
  };
}

const WORKFLOW = '.github/workflows/adlc-rails-guard.yml';

test('ownersForPaths consults only the FIRST CODEOWNERS file that exists', () => {
  // GitHub uses one file. Unioning let an IGNORED docs/CODEOWNERS grant an approver who
  // could authorize a trust-root change while GitHub itself never counted them.
  const git = fakeGit({
    '.github/CODEOWNERS': '/some/other/path @bob\n',
    'docs/CODEOWNERS': `${WORKFLOW} @alice\n`,
  });
  assert.deepEqual(ownersForPaths(git, 'base', [WORKFLOW]), [], 'an ignored file must not grant ownership');
});

test('ownersForPaths reads a lower-priority file only when the higher one is absent', () => {
  const git = fakeGit({ 'docs/CODEOWNERS': `${WORKFLOW} @alice\n` });
  assert.deepEqual(ownersForPaths(git, 'base', [WORKFLOW]), ['alice']);
});

test('ownersForPaths does not treat a NEGATED row as granting ownership', () => {
  // GitHub does not support `!` in CODEOWNERS, so `!path @alice` does not make Alice an
  // owner. Stripping the `!` and keeping the owners over-granted an approver.
  const git = fakeGit({ '.github/CODEOWNERS': `!${WORKFLOW} @alice\n` });
  assert.deepEqual(ownersForPaths(git, 'base', [WORKFLOW]), []);
});

test('coverage still treats a negated row as UN-owning (the conservative reading)', () => {
  const git = fakeGit({ '.github/CODEOWNERS': `* @alice\n!${WORKFLOW}\n` });
  assert.equal(pathHasCodeowner(git, 'base', WORKFLOW), false);
});

// #363 round 5, verified by executing the real lift path. Row precedence, not just file
// precedence: a catch-all kept granting ownership after a later, more specific row had
// taken it away — so the catch-all owner could authorize a trust-root change GitHub would
// never let them approve.
test('ownersForPaths: the LAST matching row wins, so a later specific row overrides a catch-all', () => {
  const git = fakeGit({ '.github/CODEOWNERS': '* @alice\n/.adlc/config.json @bob\n' });
  assert.deepEqual(ownersForPaths(git, 'base', ['.adlc/config.json']), ['bob']);
});

test('ownersForPaths: a catch-all still owns paths no later row claims', () => {
  const git = fakeGit({ '.github/CODEOWNERS': '* @alice\n/.adlc/config.json @bob\n' });
  assert.deepEqual(ownersForPaths(git, 'base', ['docs/ci/rails-guard.yml']), ['alice']);
});

test('ownersForPaths: a later NEGATED row leaves the path ownerless', () => {
  const git = fakeGit({ '.github/CODEOWNERS': '* @alice\n!/.adlc/config.json\n' });
  assert.deepEqual(ownersForPaths(git, 'base', ['.adlc/config.json']), []);
});

test('ownersForPaths: a later no-owner row leaves the path ownerless', () => {
  const git = fakeGit({ '.github/CODEOWNERS': '* @alice\n/.adlc/config.json\n' });
  assert.deepEqual(ownersForPaths(git, 'base', ['.adlc/config.json']), []);
});

test('ownersForPaths: distinct changed paths each resolve to their own last-match owner', () => {
  // The union ACROSS paths is deliberate — a trust-root rename has two paths that can have
  // different owners. Each path still resolves by its own last-matching row.
  const git = fakeGit({ '.github/CODEOWNERS': '* @alice\n/.adlc/config.json @bob\n' });
  assert.deepEqual(
    ownersForPaths(git, 'base', ['.adlc/config.json', 'docs/ci/rails-guard.yml']).sort(),
    ['alice', 'bob']
  );
});

test('the repository CODEOWNERS explicitly covers /package.json and /.npmrc with @voodootikigod (#501)', () => {
  const codeownersPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'CODEOWNERS');
  const content = readFileSync(codeownersPath, 'utf8');
  const git = fakeGit({ CODEOWNERS: content });
  assert.deepEqual(ownersForPaths(git, 'base', ['package.json']), ['voodootikigod']);
  assert.deepEqual(ownersForPaths(git, 'base', ['.npmrc']), ['voodootikigod']);
});
