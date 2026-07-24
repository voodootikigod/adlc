import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFleet, integrationBranchName, runExitCode } from '../lib/run.mjs';
import { resolveRunConfig } from '../lib/config.mjs';

const T = (id, opts = {}) => ({ id, title: id, scope: opts.scope ?? [`src/${id}/**`], edges: opts.edges ?? [] });

// A deps harness that records every git-ish interaction so we can assert base is
// never written and merges land on the integration branch.
function harness({ prosecuteVerdict = () => ({ verdict: 'pass' }), postMerge = () => ({ ok: true }), openPR } = {}) {
  const rec = { merges: [], worktreeStartShas: [], prosecutedStartShas: [], gatedStartShas: [], prs: [], baseWrites: [] };
  const deps = {
    baseSha: 'BASE',
    createIntegrationBranch: ({ integrationBranch }) => { rec.integrationBranch = integrationBranch; },
    createWorktree: ({ ticket }) => {
      const startSha = `tip-after-${rec.merges.length}`; // integration tip at cut time
      rec.worktreeStartShas.push({ id: ticket.id, startSha });
      return { path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha };
    },
    dispatch: () => ({ exitCode: 0, output: 'TICKET-DONE' }),
    gate: ({ startSha }) => { rec.gatedStartShas.push(startSha); return { ok: true }; },
    prosecute: ({ ticket, startSha }) => { rec.prosecutedStartShas.push(startSha); return prosecuteVerdict(ticket); },
    flail: () => ({ flail: false }),
    mergeToIntegration: ({ branch, integrationBranch }) => {
      if (integrationBranch === 'main') rec.baseWrites.push(`merge ${branch} into main`);
      rec.merges.push({ branch, into: integrationBranch });
      return { mergeSha: `merge-${branch}`, preMergeSha: 'pre' };
    },
    postMergeGate: postMerge,
    revertMerge: () => ({ method: 'reset', ok: true }),
    // The real openPR reports { opened, reason }. Default models a successful open; a test
    // can override to model gh being unavailable or a push/creation failure.
    openPR: openPR ?? (({ integrationBranch, base }) => { rec.prs.push({ integrationBranch, base }); return { opened: true }; }),
  };
  return { deps, rec };
}

test('merges land on fleet/run-<runId>, base is never written (AC13 i)', async () => {
  const all = [T('T1'), T('T2')];
  const { deps, rec } = harness();
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all, runId: 'abc', config, deps });

  assert.equal(summary.integrationBranch, integrationBranchName('abc'));
  assert.equal(summary.integrationBranch, 'fleet/run-abc');
  assert.equal(rec.baseWrites.length, 0, 'the fleet must never merge into base');
  assert.ok(rec.merges.every((m) => m.into === 'fleet/run-abc'), 'all merges target the integration branch');
  assert.deepEqual(Object.values(summary.results).sort(), ['merged', 'merged']);
});

test('run end opens at most ONE PR to base and counts it only when opened (AC13 i)', async () => {
  const all = [T('T1'), T('T2'), T('T3')];
  const { deps, rec } = harness();
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all, runId: 'abc', config, deps });
  assert.equal(rec.prs.length, 1, 'exactly one PR at run end');
  assert.equal(rec.prs[0].base, 'main');
  assert.equal(summary.prCount, 1, 'the opened PR is counted');
});

test('a REPORTED PR-open failure is not fabricated as success (round-31)', async () => {
  // merged > 0, but openPR reports { opened:false } (e.g. gh unavailable, or the push /
  // gh pr create failed). The run must NOT claim a PR exists — prCount stays 0.
  const all = [T('T1'), T('T2')];
  const { deps, rec } = harness({
    openPR: ({ integrationBranch, base }) => { rec.prs.push({ integrationBranch, base }); return { opened: false, reason: 'gh CLI not available' }; },
  });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all, runId: 'abc', config, deps });
  assert.equal(summary.merged, 2, 'precondition: tickets merged, so a PR was attempted');
  assert.equal(rec.prs.length, 1, 'openPR was invoked');
  assert.equal(summary.prCount, 0, 'a reported open-failure is NOT counted as an opened PR');
  assert.equal(summary.prOpenFailed, true, 'the attempted-but-failed open is recorded');
  assert.equal(runExitCode(summary), 2, 'merged-but-unpublished exits non-zero so automation is not told it is complete');
});

test('no PR is opened when nothing merged', async () => {
  const all = [T('T1')];
  const { deps, rec } = harness({ prosecuteVerdict: () => ({ verdict: 'unavailable', reason: 'no provider' }) });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all, runId: 'abc', config, deps });
  assert.equal(summary.results.T1, 'failed');
  assert.equal(rec.prs.length, 0);
});

test('scope and prosecution diff against the ticket startSha, not base (AC13 iii / N3)', async () => {
  const all = [T('T1'), T('T2')];
  const { deps, rec } = harness();
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  await runFleet({ all, runId: 'abc', config, deps });
  // Each ticket's gate + prosecution used the integration tip it was cut from,
  // never the literal 'BASE'.
  assert.ok(rec.gatedStartShas.every((s) => s.startsWith('tip-after-')));
  assert.ok(rec.prosecutedStartShas.every((s) => s.startsWith('tip-after-')));
  assert.ok(!rec.gatedStartShas.includes('BASE'));
});

test('a blocking prosecution keeps a ticket out of the merge set', async () => {
  const all = [T('T1')];
  const { deps, rec } = harness({ prosecuteVerdict: () => ({ verdict: 'block', reason: 'auth bypass' }) });
  const config = { ...resolveRunConfig({}, {}), baseSha: 'BASE' };
  const summary = await runFleet({ all, runId: 'abc', config, deps });
  assert.equal(summary.results.T1, 'failed');
  assert.equal(rec.merges.length, 0, 'a ticket that fails prosecution must not merge');
});
