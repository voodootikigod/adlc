// AC3 — §5 routing derivation, driven through the REAL pipeline.
//
// The point of this file is that no ticket here carries a synthetic `float`
// field. Stored tickets have no float: it is computed by @adlc/core's
// `computeFloat` over the DAG and placed on the assignment by
// `assignTicket`. Feeding routeJob a hand-written `{float: 0}` would test a
// fixture rather than the contract — and would not notice if the router stopped
// emitting float at all, which is precisely the failure that silently downgrades
// critical-path work to the cheap channel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFloat } from '../../core/index.mjs';
import { assignTicket } from '../../model-router/lib/assign.mjs';
import { buildPriors } from '../../model-router/lib/priors.mjs';
import { routeJob, deriveBuildJob } from '../lib/route-job.mjs';

const PRIORS = buildPriors([]); // no ledger history — bestTierFromPriors falls back to 'mid'

/**
 * A three-ticket DAG with a genuine critical path.
 *
 * A(3) ─┐                 earliest: A=3, B=1, C=5   makespan 5
 *       ├─→ C(2)          float:    A=0, B=2, C=0
 * B(1) ─┘
 *
 * A is critical-path work with a mid-ish rail density (so the assignment lands
 * on tier `mid`, not frontier) — the exact shape the override rule exists for.
 * B has slack, so it is ladder-start.
 */
const DAG = Object.freeze([
  { id: 'A', category: 'feature', duration: 3, edges: [{ to: 'C' }], rails: ['r1'], scope: ['s1', 's2'] },
  { id: 'B', category: 'feature', duration: 1, edges: [{ to: 'C' }], rails: ['r1'], scope: ['s1', 's2', 's3', 's4'] },
  { id: 'C', category: 'feature', duration: 2, edges: [], rails: ['r1'], scope: ['s1', 's2'] },
]);

const SPEC_TICKET = Object.freeze({
  id: 'S', category: 'spec', duration: 1, edges: [{ to: 'C' }], rails: ['r1'], scope: ['s1', 's2'],
});

/** Run the real pipeline: DAG → computeFloat → assignTicket. No synthetic floats. */
function assign(ticketId, tickets = DAG) {
  const cpm = computeFloat(tickets);
  assert.equal(cpm.error, undefined, 'fixture DAG must be acyclic');
  const ticket = tickets.find((t) => t.id === ticketId);
  const float = cpm.floats[ticket.id];
  assert.equal(typeof float, 'number', 'computeFloat must produce a float for every ticket');
  return { ticket, assignment: assignTicket(ticket, float, PRIORS), float };
}

test('the fixture DAG really does produce a critical path and a slack branch', () => {
  const cpm = computeFloat(DAG);
  assert.equal(cpm.floats.A, 0, 'A is on the critical path');
  assert.ok(cpm.floats.B > 0, 'B has slack');
  assert.deepEqual(cpm.criticalPath, ['A', 'C']);
});

test('a zero-float ordinary ticket routes frontier even when the assignment tier is mid', () => {
  const { ticket, assignment } = assign('A');
  // The precondition that makes this test meaningful: the router really did say
  // `mid`. If it ever says `frontier` on its own, the override below proves nothing.
  assert.equal(assignment.tier, 'mid', 'precondition: assignment tier is mid');
  assert.equal(assignment.float, 0);

  assert.deepEqual(routeJob({ job: 'build.critical-path', assignment, ticket }), { channel: 'frontier' });
});

test('the assignment tier still governs budget — the override is for CHANNEL purposes only', () => {
  const { assignment } = assign('A');
  assert.equal(assignment.tier, 'mid');
  assert.ok(assignment.budget > 0, 'budget still comes from the assignment, untouched by routing');
});

test('a ticket with slack routes to its assignment tier channel', () => {
  const { ticket, assignment } = assign('B');
  assert.ok(assignment.float > 0);
  assert.deepEqual(routeJob({ job: 'build.ladder-start', assignment, ticket }), { channel: assignment.tier });
});

test('a spec-category ticket is spec-class regardless of float', () => {
  const tickets = [...DAG, SPEC_TICKET];
  const { ticket, assignment } = assign('S', tickets);
  assert.ok(assignment.float > 0, 'precondition: the spec ticket has slack, so only its CATEGORY makes it frontier');
  assert.deepEqual(routeJob({ job: 'build.spec-class', assignment, ticket }), { channel: 'frontier' });
});

// ------------------------------------------------- mislabeled dispatch throws

test('a zero-float ticket labeled build.ladder-start throws', () => {
  const { ticket, assignment } = assign('A');
  assert.throws(
    () => routeJob({ job: 'build.ladder-start', assignment, ticket }),
    /derive "build\.critical-path"/
  );
});

test("a category 'spec' ticket labeled build.critical-path throws", () => {
  const tickets = [...DAG, SPEC_TICKET];
  const { ticket, assignment } = assign('S', tickets);
  assert.throws(() => routeJob({ job: 'build.critical-path', assignment, ticket }), /derive "build\.spec-class"/);
});

test('a slack ticket labeled build.critical-path throws', () => {
  const { ticket, assignment } = assign('B');
  assert.throws(() => routeJob({ job: 'build.critical-path', assignment, ticket }), /derive "build\.ladder-start"/);
});

// ------------------------------------------------------------- float hygiene

test('an assignment with an absent or non-numeric float throws — never ladder-start', () => {
  const { ticket, assignment } = assign('A');
  for (const badFloat of [undefined, null, '0', NaN, Infinity, {}]) {
    const broken = { ...assignment, float: badFloat };
    assert.throws(
      () => routeJob({ job: 'build.ladder-start', assignment: broken, ticket }),
      /assignment\.float must be a finite number/,
      `float ${JSON.stringify(badFloat)} must throw, not silently downgrade`
    );
  }
});

test('float is read from the assignment, never from the ticket', () => {
  const { ticket, assignment } = assign('A');
  // A ticket carrying a bogus float field must not be able to change the route.
  const poisoned = { ...ticket, float: 99 };
  assert.deepEqual(routeJob({ job: 'build.critical-path', assignment, ticket: poisoned }), { channel: 'frontier' });
  // ...and an assignment without float still throws even when the ticket has one.
  assert.throws(
    () => routeJob({ job: 'build.critical-path', assignment: { tier: 'mid' }, ticket: poisoned }),
    /assignment\.float must be a finite number/
  );
});

test('build routing requires both a ticket and an assignment', () => {
  const { ticket, assignment } = assign('A');
  assert.throws(() => routeJob({ job: 'build.critical-path', assignment }), /requires a ticket/);
  assert.throws(() => routeJob({ job: 'build.critical-path', ticket }), /requires an assignment/);
});

test('deriveBuildJob is the single derivation both routing and callers share', () => {
  const critical = assign('A');
  const slack = assign('B');
  assert.equal(deriveBuildJob(critical), 'build.critical-path');
  assert.equal(deriveBuildJob(slack), 'build.ladder-start');
});

// ------------------------------------------------------------- the §5 sweep

test('unknown jobs throw — the enum is closed', () => {
  for (const job of ['build.turbo', 'prosecute', 'review.cross-model', 'gate.deterministic', 'gate.deterministic.', '', null, 42]) {
    assert.throws(() => routeJob({ job }), /routeJob:/, `job ${JSON.stringify(job)} must throw`);
  }
});

test('gate.deterministic.* takes no model, and asserting a channel there is an error', () => {
  for (const job of ['gate.deterministic.spec-lint', 'gate.deterministic.rails-guard', 'gate.deterministic.hollow-test']) {
    assert.deepEqual(routeJob({ job }), { deterministic: true });
    assert.throws(() => routeJob({ job, channel: 'frontier' }), /takes no model/);
    assert.throws(() => routeJob({ job, channel: 'cheap' }), /takes no model/);
  }
});

test('table-driven sweep over every §5 row', () => {
  const critical = assign('A');
  const slack = assign('B');
  const specTickets = [...DAG, SPEC_TICKET];
  const specClass = assign('S', specTickets);

  const ROWS = [
    ['build.spec-class', specClass, { channel: 'frontier' }],
    ['build.critical-path', critical, { channel: 'frontier' }],
    ['build.ladder-start', slack, { channel: slack.assignment.tier }],
    ['prosecute.lens', {}, { channel: 'mid' }],
    ['prosecute.verdict', {}, { channel: 'frontier' }],
    ['review.cross-model.routine', {}, { reviewerGroup: 'cross-model-routine' }],
    ['review.cross-model.trust-root', {}, { reviewerGroup: 'cross-model-trust-root' }],
    ['maintain.ratchet', {}, { channel: 'mid' }],
    ['maintain.mining', {}, { channel: 'mid' }],
    ['maintain.calibration', {}, { channel: 'frontier-metered' }],
    ['gate.deterministic.spec-lint', {}, { deterministic: true }],
  ];

  for (const [job, ctx, expected] of ROWS) {
    assert.deepEqual(routeJob({ job, ...ctx }), expected, `§5 row ${job}`);
  }
  assert.equal(ROWS.length, 11, 'every §5 row is covered');
});

test('the ladder-start channel comes from the tier, and an unknown tier throws', () => {
  const { ticket, assignment } = assign('B');
  assert.deepEqual(routeJob({ job: 'build.ladder-start', assignment: { ...assignment, tier: 'cheap' }, ticket }), { channel: 'cheap' });
  assert.deepEqual(routeJob({ job: 'build.ladder-start', assignment: { ...assignment, tier: 'mid' }, ticket }), { channel: 'mid' });
  assert.throws(() => routeJob({ job: 'build.ladder-start', assignment: { ...assignment, tier: 'turbo' }, ticket }), /has no channel/);
});

test('a caller-claimed channel that disagrees with §5 throws for non-build jobs too', () => {
  assert.throws(() => routeJob({ job: 'prosecute.lens', channel: 'frontier' }), /routes it to "mid"/);
  assert.throws(() => routeJob({ job: 'review.cross-model.routine', channel: 'frontier' }), /not channel "frontier"/);
  assert.doesNotThrow(() => routeJob({ job: 'prosecute.lens', channel: 'mid' }));
});
