// cluster.test.mjs — the unit glob and lane clustering.
//
// The profile's unit globs are operator-authored, so their semantics have to be
// predictable: `packages/x/**` must match `packages/x/lib/a.mjs` and must NOT
// match `packages/xyz/a.mjs`. Clustering is what `issue-lanes` consumes, and a
// wrong unit sends an issue to the wrong lane.
//
// The matcher itself is @adlc/core's canonical one, imported rather than
// written here: a repo guard forbids hand-rolled copies because the regex form
// backtracks catastrophically on repeated globstars. These tests pin the
// semantics this package RELIES on, including the surprising one — `?` is a
// literal, not a wildcard.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clusterIssues, globMatch, unitFor, unitsForIssue } from '../lib/cluster.mjs';

test('** spans separators; * does not', () => {
  assert.ok(globMatch('packages/x/**', 'packages/x/lib/deep/a.mjs'));
  assert.ok(globMatch('packages/*/lib/a.mjs', 'packages/x/lib/a.mjs'));
  assert.equal(globMatch('packages/*/a.mjs', 'packages/x/lib/a.mjs'), false, 'a single star must not cross a slash');
});

test('a prefix is not a match — packages/x/** does not capture packages/xyz', () => {
  assert.equal(globMatch('packages/x/**', 'packages/xyz/a.mjs'), false);
});

test('**/ matches zero directories as well as many', () => {
  assert.ok(globMatch('packages/**/a.mjs', 'packages/a.mjs'), 'zero intervening directories');
  assert.ok(globMatch('packages/**/a.mjs', 'packages/x/y/a.mjs'), 'several');
});

test('a literal dot is a dot, not any character', () => {
  assert.ok(globMatch('lib/a.mjs', 'lib/a.mjs'));
  assert.equal(globMatch('lib/a.mjs', 'lib/axmjs'), false);
});

test('? is a LITERAL, not glob syntax — the canonical matcher says so', () => {
  // Worth pinning because `?` is glob syntax almost everywhere else, so a
  // profile author may reasonably expect it to match one character. Here it
  // matches a literal question mark, and a unit glob written with one will
  // silently match nothing.
  assert.equal(globMatch('lib/?.mjs', 'lib/a.mjs'), false);
  assert.ok(globMatch('lib/?.mjs', 'lib/?.mjs'));
});

test('unitFor returns the first declared unit that matches, or null', () => {
  const units = [
    { name: 'parallax', paths: ['packages/parallax/**'] },
    { name: 'core', paths: ['packages/core/**'] },
  ];
  assert.equal(unitFor('packages/core/lib/text.mjs', units), 'core');
  assert.equal(unitFor('scripts/thing.mjs', units), null);
});

test('only VERIFIED locations contribute a unit', () => {
  const units = [{ name: 'parallax', paths: ['packages/parallax/**'] }];
  const classified = { references: [{ path: 'packages/parallax/lib/a.mjs' }] };
  assert.deepEqual(unitsForIssue({ verdict: 'valid' }, classified, units), ['parallax']);
  for (const verdict of ['moved', 'unverified', 'unverifiable']) {
    assert.deepEqual(
      unitsForIssue({ verdict }, classified, units),
      [],
      `a ${verdict} location is not evidence about where the work is`
    );
  }
});

test('issues group by unit, and those with no unit are reported unclustered rather than dropped', () => {
  const units = [{ name: 'parallax', paths: ['packages/parallax/**'] }];
  const rows = [
    { number: 1, verified: { verdict: 'valid' }, classified: { references: [{ path: 'packages/parallax/a.mjs' }] } },
    { number: 2, verified: { verdict: 'valid' }, classified: { references: [{ path: 'packages/parallax/b.mjs' }] } },
    { number: 3, verified: { verdict: 'valid' }, classified: { references: [{ path: 'scripts/c.mjs' }] } },
  ];
  const { clusters, unclustered } = clusterIssues(rows, units);
  assert.deepEqual(clusters, [{ unit: 'parallax', issues: [1, 2] }]);
  assert.deepEqual(unclustered, [3], 'an unclustered issue is still in the backlog');
});

test('**/ is a DIRECTORY boundary — packages/**/a.mjs does not match packages/xa.mjs', () => {
  // The difference between `(?:.*/)?` and a bare `.*`. Without the boundary,
  // `**/a.mjs` silently matches any path merely ENDING in a.mjs, and issues land
  // in a unit they have nothing to do with.
  assert.equal(globMatch('packages/**/a.mjs', 'packages/xa.mjs'), false);
  assert.ok(globMatch('packages/**/a.mjs', 'packages/x/a.mjs'));
});

test('an issue spanning SEVERAL units is unclustered, not filed under the first', () => {
  // Raised in cross-model review, and it aligns clustering with the policy
  // §3.4a already applies: multi-unit locations are ambiguous. Filing such an
  // issue under whichever path parsed first hands a lane package-spanning work
  // labelled as one package's, and hides the other owner.
  const units = [
    { name: 'core', paths: ['packages/core/**'] },
    { name: 'prosecute', paths: ['packages/prosecute/**'] },
  ];
  const rows = [{
    number: 7,
    verified: { verdict: 'valid' },
    classified: { references: [{ path: 'packages/core/a.mjs' }, { path: 'packages/prosecute/b.mjs' }] },
  }];
  const { clusters, unclustered } = clusterIssues(rows, units);
  assert.deepEqual(clusters, []);
  assert.deepEqual(unclustered, [7]);
});
