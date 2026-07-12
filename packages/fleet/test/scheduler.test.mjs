import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRound, advanceTicket, reconcileResume } from '../lib/scheduler.mjs';

const T = (id, opts = {}) => ({
  id, title: id, scope: opts.scope ?? [`src/${id}/**`], edges: opts.edges ?? [],
  ...(opts.completed ? { completed: true } : {}),
});

// ---- planRound: readiness + serialization + cap (AC3 a–d) ----

test('planRound admits only tickets whose predecessors merged (AC3a)', async () => {
  const all = [T('T1', { edges: [{ to: 'T3' }] }), T('T2', { edges: [{ to: 'T3' }] }), T('T3')];
  let r = planRound(all, { statusById: {}, cap: 5 });
  assert.deepEqual(r.admit.map((t) => t.id).sort(), ['T1', 'T2']);
  r = planRound(all, { statusById: { T1: 'merged', T2: 'merged' }, cap: 5 });
  assert.deepEqual(r.admit.map((t) => t.id), ['T3']);
});

test('planRound never admits completed:true tickets but honors their edges (AC3b)', async () => {
  const all = [T('T1', { completed: true, edges: [{ to: 'T2' }] }), T('T2')];
  const r = planRound(all, { statusById: {}, cap: 5 });
  assert.deepEqual(r.admit.map((t) => t.id), ['T2']);
});

test('planRound never exceeds the concurrency cap (AC3c)', async () => {
  const all = [T('A'), T('B'), T('C'), T('D')];
  const r = planRound(all, { statusById: {}, inFlightIds: [], cap: 2 });
  assert.equal(r.admit.length, 2, 'at most `cap` admitted');
  // With one already in flight, only one more slot.
  const r2 = planRound(all, { statusById: { A: 'building' }, inFlightIds: ['A'], cap: 2 });
  assert.equal(r2.admit.length, 1);
});

test('planRound serializes scope-overlapping tickets (AC3d)', async () => {
  const all = [T('A', { scope: ['src/shared/**'] }), T('B', { scope: ['src/shared/x.js'] })];
  const r = planRound(all, { statusById: {}, cap: 5 });
  assert.equal(r.admit.length, 1, 'overlapping tickets cannot both dispatch');
});

test('planRound admits nothing when already at/over the cap (freeSlots floor)', async () => {
  const all = [T('A'), T('B'), T('C')];
  // Two in flight, cap 2 → zero free slots, so no admission even though C is ready.
  const r = planRound(all, { statusById: { A: 'building', B: 'building' }, inFlightIds: ['A', 'B'], cap: 2 });
  assert.equal(r.admit.length, 0, 'freeSlots must clamp to 0, never admit past the cap');
});

test('planRound default cap is 2 when unspecified', async () => {
  const all = [T('A'), T('B'), T('C')];
  const r = planRound(all, { statusById: {} }); // no cap arg → default
  assert.equal(r.admit.length, 2, 'the default concurrency cap is 2');
});

test('planRound reports subset-blocked tickets rather than silently skipping', async () => {
  const all = [T('T1', { edges: [{ to: 'T2' }] }), T('T2')];
  const r = planRound(all, { statusById: {}, cap: 5, onlyIds: ['T2'] });
  assert.deepEqual(r.blocked, ['T2']);
});

// ---- advanceTicket: pipeline policy (AC3 e–i) ----

const okBuild = () => ({ exitCode: 0, timedOut: false, output: 'TICKET-DONE' });
const okGate = () => ({ ok: true });
const passProsecute = () => ({ verdict: 'pass' });
const okMerge = () => ({ ok: true });
const noFlail = () => ({ flail: false });

test('happy path: build→gate→prosecute→merge → merged in one strike', async () => {
  const r = await advanceTicket(T('T1'), {
    dispatch: okBuild, gate: okGate, prosecute: passProsecute, merge: okMerge, flail: noFlail,
  });
  assert.equal(r.state, 'merged');
  assert.equal(r.strikes, 1);
});

test('two-strike: first build fails with dead-end context, second passes (AC3e)', async () => {
  const seen = [];
  let n = 0;
  const r = await advanceTicket(T('T1'), {
    dispatch: ({ strike, deadEnds }) => { seen.push({ strike, deadEnds: [...deadEnds] }); return ++n === 1 ? { exitCode: 1, output: 'boom' } : okBuild(); },
    gate: okGate, prosecute: passProsecute, merge: okMerge, flail: noFlail,
  });
  assert.equal(r.state, 'merged');
  assert.equal(r.strikes, 2);
  assert.equal(seen[0].deadEnds.length, 0, 'strike 1 has no prior dead-ends');
  assert.ok(seen[1].deadEnds.length > 0 && /UNTRUSTED:BUILD/.test(seen[1].deadEnds[0]), 'strike 2 receives fenced failure context');
});

test('two-strike: second failure marks the ticket failed (AC3e)', async () => {
  const r = await advanceTicket(T('T1'), {
    dispatch: () => ({ exitCode: 1, output: 'always fails' }), gate: okGate, prosecute: passProsecute, merge: okMerge, flail: noFlail,
  });
  assert.equal(r.state, 'failed');
  assert.equal(r.strikes, 2);
});

test('a diagnosed flail skips the second strike (AC3f)', async () => {
  let calls = 0;
  const r = await advanceTicket(T('T1'), {
    dispatch: () => { calls++; return { exitCode: 1, output: 'stuck' }; },
    gate: okGate, prosecute: passProsecute, merge: okMerge,
    flail: () => ({ flail: true }),
  });
  assert.equal(r.state, 'failed');
  assert.equal(r.strikes, 1, 'flail must stop after the first strike');
  assert.equal(calls, 1, 'no second dispatch when flailing');
  assert.match(r.reason, /flail/);
});

test('a TICKET-BLOCKED worker marks blocked without consuming the 2nd strike', async () => {
  let calls = 0;
  const r = await advanceTicket(T('T1'), {
    dispatch: () => { calls++; return { blocked: true, exitCode: 1, output: 'TICKET-BLOCKED: spec unclear' }; },
    gate: okGate, prosecute: passProsecute, merge: okMerge, flail: noFlail,
  });
  assert.equal(r.state, 'blocked');
  assert.equal(calls, 1);
});

test('blocking prosecution routes to a fix strike, merges only after clean re-prosecution (AC3i)', async () => {
  let pn = 0;
  const r = await advanceTicket(T('T1'), {
    dispatch: okBuild, gate: okGate,
    prosecute: () => (++pn === 1 ? { verdict: 'block', reason: 'auth bypass' } : { verdict: 'pass' }),
    merge: okMerge, flail: noFlail,
  });
  assert.equal(r.state, 'merged');
  assert.equal(r.strikes, 2, 'the block consumed a fix strike before the clean pass');
});

test('unavailable prosecution fails closed — never merges (F3)', async () => {
  let merged = false;
  const r = await advanceTicket(T('T1'), {
    dispatch: okBuild, gate: okGate,
    prosecute: () => ({ verdict: 'unavailable', reason: 'no provider' }),
    merge: () => { merged = true; return okMerge(); }, flail: noFlail,
  });
  assert.equal(r.state, 'failed');
  assert.equal(merged, false, 'must not merge when prosecution cannot complete');
});

test('failed post-merge gate triggers revert path and consumes strikes (AC3g)', async () => {
  let reverts = 0;
  const r = await advanceTicket(T('T1'), {
    dispatch: okBuild, gate: okGate, prosecute: passProsecute, flail: noFlail,
    merge: () => { reverts++; return { ok: false, reverted: true, output: 'post-merge red' }; },
  });
  assert.equal(r.state, 'failed');
  assert.equal(reverts, 2, 'post-merge failure retried once then failed, reverting each time');
});

// ---- reconcileResume (AC3h / N2) ----

test('resume classifies merged-by-integration-ancestry and does not re-dispatch (AC3h/N2)', async () => {
  const all = [T('T1'), T('T2')];
  const status = {
    integrationBranch: 'fleet/run-1',
    tickets: { T1: { state: 'building', strikes: 1, branch: 'fleet/t1' }, T2: { state: 'building', strikes: 0, branch: 'fleet/t2' } },
  };
  // T1's branch merged into the integration branch before the crash; T2's did not.
  const isAncestor = (branch) => branch === 'fleet/t1';
  const resumed = reconcileResume(all, status, { isAncestor });
  assert.equal(resumed.tickets.T1.state, 'merged', 'merged work is recognized via integration-branch ancestry, not base');
  assert.equal(resumed.tickets.T2.state, 'pending', 'unmerged in-flight ticket returns to pending');
  assert.equal(resumed.tickets.T2.strikes, 0, 'strikes preserved on resume');
  // A resumed run must not re-dispatch the merged ticket.
  const { admit } = planRound(all, { statusById: { T1: 'merged', T2: 'pending' }, cap: 5 });
  assert.deepEqual(admit.map((t) => t.id), ['T2']);
});
