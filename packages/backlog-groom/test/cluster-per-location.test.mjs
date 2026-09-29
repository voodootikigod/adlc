// cluster-per-location.test.mjs — units come from VERIFIED locations only.
//
// An issue's verdict can be `valid` on the strength of one citation while its
// other citations name a path that never existed, or a file cited with no
// excerpt. Those were never checked, so they say nothing about where the work
// is: they must not place the issue in a lane cluster, and they must not
// justify an area relabel — in the read path or when the write path re-derives
// the move.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clusterIssues, unitsForIssue } from '../lib/cluster.mjs';
import { relabelProposals } from '../lib/relabel.mjs';
import { revalidateRelabel } from '../lib/apply.mjs';
import { verifyIssue } from '../lib/verify.mjs';
import { parseProfile } from '../lib/profile.mjs';

const PROFILE = parseProfile({
  schemaVersion: 1,
  units: [
    { name: 'parallax', paths: ['packages/parallax/**'] },
    { name: 'ticket-prune', paths: ['packages/ticket-prune/**'] },
    { name: 'scripts', paths: ['scripts/**'] },
  ],
});

const SNIPPET = 'const answer = compute(input);';

/** Real verification over an injected world, so the test exercises the real hand-off. */
function verifiedRow(references, files, { labels = ['area:ticket-prune'], everExisted = () => false } = {}) {
  const classified = { number: 9, route: 'mechanical', references };
  const verified = verifyIssue(classified, {
    pathKind: (p) => (p in files ? 'blob' : null),
    readFile: (p) => files[p],
    lastCommitFor: () => 'abc1234',
    everExisted,
  });
  return { number: 9, labels, classified, verified, rank: null };
}

test('a never-existed path does not place the issue in its unit', () => {
  const row = verifiedRow(
    [
      { path: 'packages/parallax/lib/typo.mjs', line: 9, snippet: SNIPPET },
      { path: 'scripts/foo.mjs', line: 1, snippet: SNIPPET },
    ],
    { 'scripts/foo.mjs': `${SNIPPET}\n` },
  );
  assert.equal(row.verified.verdict, 'valid');
  assert.deepEqual(unitsForIssue(row.verified, row.classified, PROFILE.units), ['scripts']);
  const { clusters } = clusterIssues([row], PROFILE.units);
  assert.deepEqual(clusters, [{ unit: 'scripts', issues: [9] }]);
});

test('a never-existed path does not drive an area relabel', () => {
  const row = verifiedRow(
    [
      { path: 'packages/parallax/lib/typo.mjs', line: 9, snippet: SNIPPET },
      { path: 'unowned/foo.mjs', line: 1, snippet: SNIPPET },
    ],
    { 'unowned/foo.mjs': `${SNIPPET}\n` },
  );
  const area = relabelProposals([row], PROFILE).filter((p) => p.field === 'area');
  assert.deepEqual(area, [], 'an unverified location is not evidence the code moved');
});

test('a path cited with no excerpt does not drive an area relabel', () => {
  const row = verifiedRow(
    [
      { path: 'packages/parallax/lib/modes.mjs', line: 3, snippets: [] },
      { path: 'unowned/foo.mjs', line: 1, snippet: SNIPPET },
    ],
    { 'packages/parallax/lib/modes.mjs': 'anything\n', 'unowned/foo.mjs': `${SNIPPET}\n` },
  );
  assert.deepEqual(relabelProposals([row], PROFILE).filter((p) => p.field === 'area'), []);
});

test('an area relabel names only the verified paths in its evidence', () => {
  const row = verifiedRow(
    [
      { path: 'packages/parallax/lib/modes.mjs', line: 1, snippet: SNIPPET },
      { path: 'packages/parallax/lib/typo.mjs', line: 9, snippet: SNIPPET },
    ],
    { 'packages/parallax/lib/modes.mjs': `${SNIPPET}\n` },
  );
  const [area] = relabelProposals([row], PROFILE).filter((p) => p.field === 'area');
  assert.equal(area.to, 'area:parallax');
  assert.doesNotMatch(area.evidence, /typo\.mjs/);
});

test('the write path refuses an area move derived from an unverified location', () => {
  const row = verifiedRow(
    [
      { path: 'packages/parallax/lib/typo.mjs', line: 9, snippet: SNIPPET },
      { path: 'unowned/foo.mjs', line: 1, snippet: SNIPPET },
    ],
    { 'unowned/foo.mjs': `${SNIPPET}\n` },
  );
  const check = revalidateRelabel(
    { number: 9, action: 'relabel', field: 'area', from: 'area:ticket-prune', to: 'area:parallax' },
    { issue: { labels: ['area:ticket-prune'] }, classified: row.classified, recomputed: row.verified, profile: PROFILE },
  );
  assert.equal(check.ok, false);
});

test('a verdict carrying no verifiedPaths yields no unit (fail closed)', () => {
  const classified = { references: [{ path: 'packages/parallax/a.mjs' }] };
  assert.deepEqual(unitsForIssue({ verdict: 'valid' }, classified, PROFILE.units), []);
});

test('a verified path the issue does not cite is ignored', () => {
  const classified = { references: [{ path: 'scripts/a.mjs' }] };
  const verified = { verdict: 'valid', verifiedPaths: ['scripts/a.mjs', 'packages/parallax/b.mjs'] };
  assert.deepEqual(unitsForIssue(verified, classified, PROFILE.units), ['scripts']);
});
