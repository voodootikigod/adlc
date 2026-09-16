// floor-ladder.test.mjs — issue #700: `--floor` is the frontier/P3 cutoff, and
// it does NOT move the cheap/mid ladder start.
//
// The flag tables called `--floor` the "minimum rail density for cheap-tier
// assignment". It is not: the floor is consulted only by Rule 1b (below it, a
// ticket is forced to frontier and the router reports a P3 finding). A ticket
// that clears the floor and has float starts its ladder on `cheap` or `mid`
// according to a FIXED threshold the floor cannot reach. An operator who moved
// `--floor` to change cheap-tier routing moved only the frontier cutoff.
//
// This file pins the behaviour the docs now describe, and pins the docs to it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { assignTicket, CHEAP_TIER_MIN_DENSITY } from '../lib/assign.mjs';
import { buildPriors } from '../lib/priors.mjs';

const PRIORS = buildPriors([]);
// Any positive float takes a ticket past Rule 2 (critical path) to the ladder.
const SLACK = 3;

/** A ladder-eligible ticket with exactly `rails / scope` rail density. */
function ladderTicket(rails, scope) {
  return {
    id: `T-${rails}-of-${scope}`,
    title: 'ladder candidate',
    category: 'feature',
    rails: Array.from({ length: rails }, (_, i) => `rail-${i}`),
    scope: Array.from({ length: scope }, (_, i) => `scope-${i}`),
  };
}

test('the cheap/mid ladder start is a named constant equal to 0.5', () => {
  assert.equal(CHEAP_TIER_MIN_DENSITY, 0.5);
});

test('a density exactly at the ladder threshold starts cheap; just below starts mid', () => {
  const atThreshold = assignTicket(ladderTicket(1, 2), SLACK, PRIORS);
  assert.equal(atThreshold.railDensity, CHEAP_TIER_MIN_DENSITY);
  assert.equal(atThreshold.mode, 'ladder');
  assert.equal(atThreshold.tier, 'cheap');

  const justBelow = assignTicket(ladderTicket(49, 100), SLACK, PRIORS);
  assert.ok(justBelow.railDensity < CHEAP_TIER_MIN_DENSITY);
  assert.equal(justBelow.mode, 'ladder');
  assert.equal(justBelow.tier, 'mid');
});

test('moving the floor does not move the ladder start of a ticket that clears it', () => {
  // Densities 0.3 and 0.6 clear every floor below, so each floor must yield the
  // same ladder start — the floor has no say once a ticket is above it.
  const cases = [
    { ticket: ladderTicket(3, 10), expected: 'mid' },
    { ticket: ladderTicket(3, 5), expected: 'cheap' },
  ];
  for (const { ticket, expected } of cases) {
    for (const floor of [0.05, 0.25, 0.3]) {
      const route = assignTicket(ticket, SLACK, PRIORS, floor);
      assert.equal(route.mode, 'ladder', `${ticket.id} under floor ${floor}`);
      assert.equal(route.tier, expected, `${ticket.id} under floor ${floor}`);
    }
  }
});

test('the floor is what sends a ticket below it to frontier', () => {
  // The other half of the claim: the floor's one effect is the frontier cutoff.
  const route = assignTicket(ladderTicket(3, 5), SLACK, PRIORS, 0.9);
  assert.equal(route.tier, 'frontier');
  assert.equal(route.mode, 'direct');
  assert.match(route.reason, /P3 finding/);
});

// ── the docs row ───────────────────────────────────────────────────────────────

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCS = [
  'packages/model-router/README.md',
  'docs/tools/model-router.md',
  'apps/docs/content/docs/toolkit/model-router.mdx',
];

/**
 * The sentence every copy of the `--floor` row opens with, word for word. The
 * ladder threshold is interpolated from the constant, so the docs cannot keep
 * claiming a number the router no longer uses.
 */
const FLOOR_ROLE =
  'Rail-density floor: a non-frontier-category ticket whose `railDensity` is below it is forced to frontier ' +
  'and raises a P3 finding (exit 2). It does not move the cheap/mid ladder start, which is a fixed ' +
  `\`railDensity >= ${CHEAP_TIER_MIN_DENSITY}\`.`;

function floorRow(relPath) {
  const rows = readFileSync(join(REPO_ROOT, relPath), 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^\|\s*`--floor\b/.test(line));
  assert.equal(rows.length, 1, `${relPath} must have exactly one --floor flag row`);
  return rows[0];
}

for (const relPath of DOCS) {
  test(`${relPath}: the --floor row describes the frontier/P3 cutoff, not cheap-tier assignment`, () => {
    const row = floorRow(relPath);
    assert.ok(row.includes(FLOOR_ROLE), `${relPath} --floor row must contain:\n  ${FLOOR_ROLE}\ngot:\n  ${row}`);
    assert.ok(!row.includes('cheap-tier assignment'), `${relPath} still calls --floor the cheap-tier threshold`);
    // The range and zero-rejection statement from #697 stays.
    assert.ok(row.includes('greater than 0 and at most 1'), `${relPath} lost the (0, 1] range statement`);
    assert.match(row, /`0` is rejected/, `${relPath} lost the zero-rejection statement`);
  });
}
