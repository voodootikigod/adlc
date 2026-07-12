import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFleet } from '../lib/run.mjs';
import { advanceTicket } from '../lib/scheduler.mjs';

const T = (id) => ({ id, title: id, scope: [`src/${id}/**`], edges: [] });
const okBuild = () => ({ exitCode: 0, output: 'TICKET-DONE' });
const baseDeps = (over = {}) => ({
  baseSha: 'BASE',
  createIntegrationBranch: () => {}, createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id}`, startSha: 'tip' }),
  dispatch: okBuild, gate: () => ({ ok: true }), prosecute: () => ({ verdict: 'pass' }),
  flail: () => ({ flail: false }), mergeToIntegration: () => ({ mergeSha: 'm', preMergeSha: 'p' }),
  postMergeGate: () => ({ ok: true }), revertMerge: () => ({ method: 'reset', ok: true }),
  ...over,
});

test('recordGate is invoked per ticket for BOTH p4 and p5 on a merged ticket (AC5)', async () => {
  const recorded = [];
  const deps = baseDeps({ recordGate: ({ ticket, phase, ok }) => recorded.push(`${ticket.id}:${phase}:${ok}`) });
  await runFleet({ all: [T('T1')], runId: 'e', config: { concurrency: 1, base: 'main', baseSha: 'BASE' }, deps });
  assert.ok(recorded.includes('T1:p4:true'), 'P4 (build/gate) outcome recorded');
  assert.ok(recorded.includes('T1:p5:true'), 'P5 (prosecution) outcome recorded');
});

test('a failing prosecution records p5:false', async () => {
  const recorded = [];
  const deps = baseDeps({
    prosecute: () => ({ verdict: 'unavailable', reason: 'no provider' }),
    recordGate: ({ phase, ok }) => recorded.push(`${phase}:${ok}`),
  });
  await runFleet({ all: [T('T1')], runId: 'e', config: { concurrency: 1, base: 'main', baseSha: 'BASE' }, deps });
  assert.ok(recorded.includes('p4:true'));
  assert.ok(recorded.includes('p5:false'), 'a fail-closed prosecution records p5:false');
});

test('a THROWING recorder does NOT abort the run (AC5 best-effort)', async () => {
  const deps = baseDeps({ recordGate: () => { throw new Error('gate-manifest unavailable'); } });
  const summary = await runFleet({ all: [T('T1')], runId: 'e', config: { concurrency: 1, base: 'main', baseSha: 'BASE' }, deps });
  assert.equal(summary.results.T1, 'merged', 'the run completes despite recorder errors');
});

test('advanceTicket exposes the prosecution verdict for status display (AC5)', async () => {
  const r = await advanceTicket(T('T1'), {
    dispatch: okBuild, gate: () => ({ ok: true }), prosecute: () => ({ verdict: 'pass' }),
    merge: () => ({ ok: true }), flail: () => ({ flail: false }),
  });
  assert.equal(r.prosecution, 'pass');
  assert.equal(r.gatePassed, true);
});
