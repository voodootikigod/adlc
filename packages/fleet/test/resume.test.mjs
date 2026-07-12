import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileRun } from '../lib/resume.mjs';
import { planRound } from '../lib/scheduler.mjs';
import { runFleet } from '../lib/run.mjs';

const T = (id) => ({ id, title: id, scope: [`src/${id}/**`], edges: [] });
const all = [T('T1'), T('T2')];

// Fake git: `ancestors` = branches that ARE ancestors of the integration branch;
// `exists` controls rev-parse/cat-file; records aborts.
function fakeGit(rec, { ancestors = [], branchExists = true, baseExists = true } = {}) {
  return () => (...args) => {
    const verb = args[0];
    if (verb === 'rev-parse') { if (!branchExists) throw new Error('unknown revision'); return 'IBSHA'; }
    if (verb === 'cat-file') { if (!baseExists) throw new Error('not found'); return ''; }
    if (verb === 'merge-base') { if (ancestors.includes(args[2])) return ''; throw new Error('not ancestor'); }
    if (verb === 'rebase' || verb === 'merge') { rec.aborts.push(args.join(' ')); return ''; }
    if (verb === 'worktree') { rec.prune = true; return ''; }
    return '';
  };
}

const statusWith = (over = {}) => ({
  runId: 'r1', integrationBranch: 'fleet/run-r1', baseSha: 'BASE',
  tickets: { T1: { state: 'building', strikes: 1, branch: 'fleet/t1' }, T2: { state: 'building', strikes: 0, branch: 'fleet/t2' } },
  ...over,
});

test('no status → nothing to resume', () => {
  assert.deepEqual(reconcileRun({ all, status: null, repo: '/r', io: { git: () => () => '' } }), { resume: false });
});

test('resume reconciles merged-by-integration-ancestry, others to pending; no re-dispatch (AC3)', () => {
  const rec = { aborts: [] };
  const io = { git: fakeGit(rec, { ancestors: ['fleet/t1'] }) };
  const r = reconcileRun({ all, status: statusWith(), repo: '/r', io });
  assert.equal(r.resume, true);
  assert.equal(r.status.tickets.T1.state, 'merged', 'ancestor of integration branch → merged');
  assert.equal(r.status.tickets.T2.state, 'pending', 'non-ancestor → pending');
  assert.equal(r.status.tickets.T2.strikes, 0, 'strikes preserved');
  // A resumed run must not re-dispatch the merged ticket.
  const { admit } = planRound(all, { statusById: { T1: 'merged', T2: 'pending' }, cap: 5 });
  assert.deepEqual(admit.map((t) => t.id), ['T2']);
});

test('resume aborts any in-progress git op and prunes stale worktrees (AC3)', () => {
  const rec = { aborts: [] };
  const io = { git: fakeGit(rec, { ancestors: [] }) };
  reconcileRun({ all, status: statusWith(), repo: '/r', io });
  assert.ok(rec.aborts.some((c) => c.startsWith('rebase')), 'rebase --abort attempted');
  assert.ok(rec.aborts.some((c) => c.startsWith('merge')), 'merge --abort attempted');
  assert.equal(rec.prune, true);
});

test('resume REFUSES when the recorded integration branch is missing (AC3)', () => {
  const io = { git: fakeGit({ aborts: [] }, { branchExists: false }) };
  const r = reconcileRun({ all, status: statusWith(), repo: '/r', io });
  assert.equal(r.refused, true);
  assert.match(r.reason, /integration branch.*missing|deleted/i);
});

test('resume REFUSES when the recorded baseSha is gone', () => {
  const io = { git: fakeGit({ aborts: [] }, { baseExists: false }) };
  const r = reconcileRun({ all, status: statusWith(), repo: '/r', io });
  assert.equal(r.refused, true);
  assert.match(r.reason, /baseSha.*gone/i);
});

test('resume refuses a status with no integration branch', () => {
  const io = { git: () => () => '' };
  const r = reconcileRun({ all, status: statusWith({ integrationBranch: undefined }), repo: '/r', io });
  assert.equal(r.refused, true);
});

test('runFleet CONTINUES a resumed run: reuses branch, does not re-create it or re-dispatch merged (L3)', async () => {
  let createdIntegration = 0;
  const dispatched = [];
  const resumeStatus = {
    runId: 'old', base: 'main', baseSha: 'BASE', integrationBranch: 'fleet/run-old',
    tickets: { T1: { state: 'merged', branch: 'fleet/t1' }, T2: { state: 'pending', branch: 'fleet/t2' } },
  };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: () => { createdIntegration++; },
    createWorktree: ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id}`, startSha: 'tip' }),
    dispatch: ({ ticket }) => { dispatched.push(ticket.id); return { exitCode: 0, output: 'TICKET-DONE' }; },
    gate: () => ({ ok: true }), prosecute: () => ({ verdict: 'pass' }), flail: () => ({ flail: false }),
    mergeToIntegration: () => ({ mergeSha: 'm', preMergeSha: 'p' }), postMergeGate: () => ({ ok: true }), revertMerge: () => ({ method: 'reset', ok: true }),
  };
  const summary = await runFleet({
    all, runId: 'IGNORED', config: { concurrency: 2, base: 'main', baseSha: 'BASE' }, deps,
    resume: { status: resumeStatus, integrationBranch: 'fleet/run-old' },
  });
  assert.equal(summary.integrationBranch, 'fleet/run-old', 'continues the recorded integration branch');
  assert.equal(createdIntegration, 0, 'does NOT re-create the integration branch on resume');
  assert.ok(!dispatched.includes('T1'), 'the already-merged ticket is NOT re-dispatched');
  assert.ok(dispatched.includes('T2'), 'the still-pending ticket is picked up');
  assert.equal(summary.results.T1, 'merged');
});
