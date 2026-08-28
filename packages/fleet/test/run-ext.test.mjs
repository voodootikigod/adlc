// fleet-ext at the run level: --no-pr (item 1), --no-complete (item 2), the
// external wall clock (item 5) incl. the process-group kill, strike accounting
// for the caller (item 9), and pausing propagated into the exit code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFleet, runExitCode, pausedCount } from '../lib/run.mjs';
import { spawnAsync } from '../lib/spawn-async.mjs';

const T = (id) => ({ id, title: id, scope: [`src/${id}/**`], edges: [] });

function deps(rec, over = {}) {
  return {
    createIntegrationBranch: async () => {},
    createWorktree: async ({ ticket }) => ({ path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'S0' }),
    dispatch: async (a) => { rec.dispatch.push(a); return over.dispatch ? over.dispatch(a) : { exitCode: 0, output: 'TICKET-DONE', timedOut: false }; },
    gate: async () => ({ ok: true }),
    prosecute: async () => ({ verdict: 'pass', reason: 'clean', review: { provider: 'codex', verdict: 'approve', revision: 'R' } }),
    flail: async () => ({ flail: false }),
    mergeToIntegration: async () => ({ mergeSha: 'M', preMergeSha: 'P' }),
    postMergeGate: async () => ({ ok: true }),
    revertMerge: async () => ({ ok: true, method: 'reset' }),
    completeTicket: async (a) => { rec.complete.push(a); return { completed: true, preCompletionSha: 'P' }; },
    revertCompletion: async () => {},
    openPR: async (a) => { rec.openPR.push(a); return { opened: true }; },
    cleanup: async () => {},
    preStrike: over.preStrike,
    now: over.now,
  };
}
const newRec = () => ({ dispatch: [], complete: [], openPR: [] });

test('--no-pr: a merged run opens NO PR, exits 0, and is not reported as a PR failure', async () => {
  const rec = newRec();
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, noPr: true }, deps: deps(rec) });
  assert.equal(rec.openPR.length, 0);
  assert.equal(s.prCount, 0); assert.equal(s.prOpenFailed, false);
  assert.equal(runExitCode(s), 0);
  assert.equal(s.results.A, 'merged');
});

test('without --no-pr the PR is still opened (default unchanged)', async () => {
  const rec = newRec();
  await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1 }, deps: deps(rec) });
  assert.equal(rec.openPR.length, 1);
});

test('--no-complete: the post-merge gate passes and completeTicket is NEVER called; default still completes', async () => {
  const rec = newRec();
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, noComplete: true }, deps: deps(rec) });
  assert.equal(rec.complete.length, 0);
  assert.equal(s.results.A, 'merged');
  const rec2 = newRec();
  await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1 }, deps: deps(rec2) });
  assert.equal(rec2.complete.length, 1);
});

test('an already-expired wall clock dispatches nothing, leaves the ticket pending (resumable), reports wall-clock, exits 2', async () => {
  const rec = newRec();
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 100 }, deps: deps(rec, { now: () => 100 }) });
  assert.equal(rec.dispatch.length, 0);
  assert.equal(s.wallClockExpired, true);
  assert.equal(s.results.A, undefined, 'never admitted — stays pending for the resume');
  assert.equal(runExitCode(s), 2);
});

test('a wall clock expiring MID-STRIKE pauses that ticket with wall-clock and exits 2; the strike is counted', async () => {
  const rec = newRec();
  let t = 0;
  const d = deps(rec, { now: () => t, dispatch: () => { t = 10_000; return { exitCode: 124, output: '', timedOut: true }; } });
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 5000, maxStrikes: 3 }, deps: d });
  assert.equal(s.results.A, 'paused');
  assert.equal(s.status.tickets.A.reasonCode, 'wall-clock');
  assert.equal(s.status.tickets.A.strikes, 1);
  assert.equal(s.strikesConsumed, 1);
  assert.equal(s.wallClockExpired, true);
  assert.equal(runExitCode(s), 2);
  assert.equal(pausedCount(s.results), 1);
});

test('a refused pre-strike pauses the ticket (quota-paused), zero dispatches, exit 2, strikesConsumed 0', async () => {
  const rec = newRec();
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1 }, deps: deps(rec, { preStrike: async () => ({ ok: false, reason: 'quota' }) }) });
  assert.equal(rec.dispatch.length, 0);
  assert.equal(s.results.A, 'paused');
  assert.equal(s.status.tickets.A.reasonCode, 'quota-paused');
  assert.equal(s.strikesConsumed, 0);
  assert.equal(runExitCode(s), 2);
});

test('a resumed ticket continues from its recorded strikes and strikesConsumed counts only THIS invocation', async () => {
  const rec = newRec();
  let n = 0;
  const d = deps(rec, { dispatch: () => (++n === 1 ? { exitCode: 1, output: 'x', timedOut: false } : { exitCode: 0, output: 'TICKET-DONE', timedOut: false }) });
  const resume = { integrationBranch: 'fleet/run-r', status: { runId: 'r', integrationBranch: 'fleet/run-r', baseSha: 'B', tickets: { A: { state: 'pending', strikes: 1, branch: 'fleet/a' } } } };
  const s = await runFleet({ all: [T('A')], runId: 'r', resume, config: { base: 'main', concurrency: 1, maxStrikes: 3 }, deps: { ...d, ensureIntegrationWorktree: async () => {} } });
  assert.equal(rec.dispatch[0].strike, 2, 'the first dispatch of the resume is strike 2');
  assert.equal(s.results.A, 'merged');
  assert.equal(s.status.tickets.A.strikes, 3);
  assert.equal(s.strikesConsumed, 2);
});

test('a subset-blocked ticket carries reasonCode ticket-blocked (never the strikes-exhausted fallback)', async () => {
  const rec = newRec();
  const all = [{ id: 'A', title: 'A', scope: ['src/a/**'], edges: [{ to: 'B' }] }, T('B')];
  const s = await runFleet({ all, runId: 'r', config: { base: 'main', concurrency: 1, onlyIds: ['B'] }, deps: deps(rec) });
  assert.equal(s.results.B, 'blocked');
  assert.equal(s.status.tickets.B.reasonCode, 'ticket-blocked');
  assert.equal(rec.dispatch.length, 0);
});

test('the per-ticket status carries reasonCode and review meta for the --json document', async () => {
  const rec = newRec();
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1 }, deps: deps(rec) });
  assert.deepEqual(s.status.tickets.A.review, { provider: 'codex', verdict: 'approve', revision: 'R', rounds: 1 });
  assert.equal(s.status.tickets.A.reasonCode, null);
});

// ── item 5, the kill: the worker is a process TREE and the wall clock must end all of it ──

test('spawnAsync killGroup: a SIGTERM-ignoring child tree is ended by SIGKILL to the group and the call resolves timedOut', async () => {
  const kills = [];
  const realKill = (pid, sig) => { kills.push({ pid, sig }); process.kill(pid, sig); };
  const script = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  const started = Date.now();
  const res = await spawnAsync(process.execPath, ['-e', script], { timeout: 200, killGroup: true, killGraceMs: 150, kill: realKill, encoding: 'utf8' });
  assert.equal(res.timedOut, true);
  assert.ok(kills.length >= 2, `both signals were sent (${JSON.stringify(kills)})`);
  assert.ok(kills.every((k) => k.pid < 0), 'signals target the process GROUP (negative pid), not just the leader');
  assert.deepEqual(kills.map((k) => k.sig), ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 5000, 'the grace period bounds the wait');
});

test('spawnAsync without killGroup keeps the legacy single-process SIGTERM (byte-identical default)', async () => {
  // The injected `kill` records AND really signals, so a defaulted-on group kill
  // (the mutant) is observed as a recorded negative-pid signal rather than as a
  // hung test — and a SIGTERM-honouring child ends either way.
  const kills = [];
  const realKill = (pid, sig) => { kills.push({ pid, sig }); process.kill(pid, sig); };
  const res = await spawnAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { timeout: 100, killGraceMs: 100, kill: realKill, encoding: 'utf8' });
  assert.equal(res.timedOut, true);
  assert.deepEqual(kills, [], 'the injected group kill is never used on the legacy path — the child alone gets child.kill(SIGTERM)');
});

test('the merge re-checks the deadline INSIDE its mutex: a merge queued behind a long post-merge gate never lands past the wall clock (codex r4)', async () => {
  const rec = newRec();
  let t = 0; let merges = 0;
  const deadline = 5000;
  const d = {
    ...deps(rec, { now: () => t }),
    mergeToIntegration: async ({ ticket }) => { merges++; return { mergeSha: `M-${ticket.id}`, preMergeSha: 'P' }; },
    // A's post-merge gate runs long enough to exhaust the budget while B waits on the mutex.
    postMergeGate: async () => { t = deadline + 1; return { ok: true }; },
  };
  const s = await runFleet({ all: [{ ...T('A'), scope: ['a/**'] }, { ...T('B'), scope: ['b/**'] }], runId: 'r', config: { base: 'main', concurrency: 2, deadline, noPr: true }, deps: d });
  assert.equal(merges, 1, 'exactly one merge landed (the one that entered the mutex before expiry)');
  assert.deepEqual(Object.values(s.results).sort(), ['merged', 'paused'], `one merged, the queued one paused: ${JSON.stringify(s.results)}`);
});

test('a per-ticket worktree setup failure is that ticket\'s recorded outcome; the other in-flight ticket completes and the run returns normally (codex r4)', async () => {
  const rec = newRec();
  const d = { ...deps(rec), createWorktree: async ({ ticket }) => { if (ticket.id === 'A') throw new Error('worktree init exploded'); return { path: `/wt/${ticket.id}`, branch: `fleet/${ticket.id.toLowerCase()}`, startSha: 'S0' }; } };
  const s = await runFleet({ all: [T('A'), T('B')], runId: 'r', config: { base: 'main', concurrency: 2, noPr: true }, deps: d });
  assert.equal(s.results.A, 'failed');
  assert.equal(s.results.B, 'merged', 'the sibling ticket ran to completion');
  assert.match(s.tickets?.A?.reason ?? s.status?.tickets?.A?.reason ?? 'worktree setup failed', /worktree setup failed/);
});
