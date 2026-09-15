// relabel.test.mjs — AC23.
//
// Two triggers produce a relabel proposal and nothing else does (spec §3.4a):
// a computed rank that disagrees with the priority label (a judgment, so the
// reviewer is shown reasoning), and verified locations sitting in a different
// unit than the `area:` label claims (mechanical, so the reviewer is shown
// paths).
//
// The exclusion is the load-bearing half: an issue whose locations could NOT be
// verified never produces an area relabel, because an unverified location is not
// evidence that the code moved.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relabelProposals } from '../lib/relabel.mjs';
import { parseProfile } from '../lib/profile.mjs';

const PROFILE = parseProfile({
  schemaVersion: 1,
  units: [
    { name: 'parallax', paths: ['packages/parallax/**'] },
    { name: 'ticket-prune', paths: ['packages/ticket-prune/**'] },
  ],
});

function row({ number = 1, verdict = 'valid', labels = [], paths = ['packages/parallax/lib/modes.mjs'], band = 'high' }) {
  return {
    number,
    labels,
    verified: { number, verdict, route: 'mechanical' },
    classified: { number, route: 'mechanical', references: paths.map((p) => ({ path: p, line: 1, snippet: 'x' })) },
    rank: { band, score: 0.8 },
  };
}

test('AC23: a rank disagreeing with the priority label proposes a priority relabel, with reasoning', () => {
  const props = relabelProposals([row({ labels: ['P3-low'], band: 'high' })], PROFILE);
  const p = props.find((x) => x.field === 'priority');
  assert.ok(p, 'a disagreement must surface');
  assert.equal(p.from, 'P3-low');
  assert.equal(p.to, 'P1-high');
  assert.match(p.evidence, /rank/i, 'priority is a judgment, so the reviewer is shown reasoning');
});

test('AC23: a rank AGREEING with the label proposes nothing', () => {
  const props = relabelProposals([row({ labels: ['P1-high'], band: 'high' })], PROFILE);
  assert.deepEqual(props.filter((x) => x.field === 'priority'), []);
});

test('AC23: an issue with no priority label at all proposes nothing — absence is not disagreement', () => {
  // Proposing a label for every unlabelled issue would bury the real
  // disagreements under hundreds of low-signal proposals.
  const props = relabelProposals([row({ labels: [], band: 'high' })], PROFILE);
  assert.deepEqual(props.filter((x) => x.field === 'priority'), []);
});

test('AC23: verified locations in a different unit than the area label propose an area relabel', () => {
  const props = relabelProposals(
    [row({ labels: ['area:ticket-prune'], paths: ['packages/parallax/lib/modes.mjs'] })],
    PROFILE
  );
  const a = props.find((x) => x.field === 'area');
  assert.ok(a);
  assert.equal(a.from, 'area:ticket-prune');
  assert.equal(a.to, 'area:parallax');
  assert.match(a.evidence, /packages\/parallax\/lib\/modes\.mjs/, 'mechanical, so the reviewer is shown the paths, not an argument');
});

test('AC23: matching area label proposes nothing', () => {
  const props = relabelProposals([row({ labels: ['area:parallax'] })], PROFILE);
  assert.deepEqual(props.filter((x) => x.field === 'area'), []);
});

test('AC23: an UNVERIFIED location never produces an area relabel', () => {
  // The exclusion the spec calls out by name: an unverified location is not
  // evidence that the code moved.
  for (const verdict of ['unverified', 'unverifiable', 'moved']) {
    const props = relabelProposals(
      [row({ verdict, labels: ['area:ticket-prune'], paths: ['packages/parallax/lib/modes.mjs'] })],
      PROFILE
    );
    assert.deepEqual(
      props.filter((x) => x.field === 'area'),
      [],
      `verdict ${verdict} must not move an area label`
    );
  }
});

test('AC23: an issue with no area label proposes no area change', () => {
  const props = relabelProposals([row({ labels: [] })], PROFILE);
  assert.deepEqual(props.filter((x) => x.field === 'area'), []);
});

test('AC23: a verified path in NO declared unit proposes nothing — the profile is the authority', () => {
  const props = relabelProposals(
    [row({ labels: ['area:parallax'], paths: ['scripts/some-script.mjs'] })],
    PROFILE
  );
  assert.deepEqual(props.filter((x) => x.field === 'area'), []);
});

test('AC23: locations spanning two units propose nothing — an ambiguous move is not a provable one', () => {
  const props = relabelProposals(
    [row({ labels: ['area:ticket-prune'], paths: ['packages/parallax/lib/a.mjs', 'packages/ticket-prune/lib/b.mjs'] })],
    PROFILE
  );
  assert.deepEqual(props.filter((x) => x.field === 'area'), [], 'still partly where the label says — nothing mechanical to prove');
});

test('AC23: both triggers can fire for one issue, as two separate proposals', () => {
  const props = relabelProposals(
    [row({ labels: ['P3-low', 'area:ticket-prune'], band: 'high', paths: ['packages/parallax/lib/a.mjs'] })],
    PROFILE
  );
  assert.deepEqual(props.map((p) => p.field).sort(), ['area', 'priority']);
});

test('AC23: every proposal carries the issue number and an action class of relabel', () => {
  const props = relabelProposals([row({ number: 42, labels: ['P3-low', 'area:ticket-prune'], band: 'high' })], PROFILE);
  for (const p of props) {
    assert.equal(p.number, 42);
    assert.equal(p.action, 'relabel', 'the write path gates on the action class');
  }
});

test('AC23: a fixed issue proposes no priority change — its rank is low by construction, not by judgment', () => {
  // A `fixed` issue is heading for a close proposal; re-prioritising it on the
  // way out is noise.
  const props = relabelProposals([row({ verdict: 'fixed', labels: ['P1-high'], band: 'low' })], PROFILE);
  assert.deepEqual(props.filter((x) => x.field === 'priority'), []);
});
