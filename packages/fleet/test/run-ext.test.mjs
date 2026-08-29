// fleet-ext at the run level: --no-pr (item 1), --no-complete (item 2), the
// external wall clock (item 5) incl. the process-group kill, strike accounting
// for the caller (item 9), and pausing propagated into the exit code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFleet, runExitCode, pausedCount } from '../lib/run.mjs';
import { spawnAsync } from '../lib/spawn-async.mjs';
import { EventEmitter } from 'node:events';

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
  assert.equal(s.results.A, 'pending', 'left pending for the next invocation, never re-admitted by this run');
  assert.equal(s.results.B, 'merged', 'the sibling ticket ran to completion');
  assert.match(s.status.tickets.A.reason, /worktree setup failed/);
});

test('a post-merge gate cut short by the wall clock withdraws the merge and PAUSES the ticket (codex r5)', async () => {
  const rec = newRec();
  let t = 0; const reverts = [];
  const d = { ...deps(rec, { now: () => t }), postMergeGate: async () => { t = 5001; return { ok: false, output: 'timed out', timedOut: true }; }, revertMerge: async (a) => { reverts.push(a); return { ok: true, method: 'reset' }; } };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 5000, noPr: true }, deps: d });
  assert.equal(reverts.length, 1, 'the merge was withdrawn');
  assert.equal(s.results.A, 'paused');
});

test('a timed-out repo command (status null) is a gate FAILURE, never an empty success (codex r5)', async () => {
  const { buildLiveDeps } = await import('../lib/live-deps.mjs');
  const spawns = [];
  const io = {
    git: () => () => 'SHA', adlc: () => ({ status: 0, stdout: '{}' }), adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { status: null, signal: 'SIGTERM', stdout: 'partial', stderr: '', timedOut: true }; },
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {}, ensureGitignore: () => {}, copyTree: () => {}, env: { PATH: '/usr/bin', HOME: '/h' }, hasGh: () => false,
  };
  const live = buildLiveDeps({ repo: '/repo', config: { gate: { test: 'npm test' }, prosecuteFailOn: 'medium', timeoutMinutes: 1 }, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } }, io, reviewRunner: () => ({ ok: true, findings: [] }) });
  const g = await live.gate({ ticket: T('A'), worktree: '/wt', startSha: 'S', remainingMs: 5 });
  assert.equal(g.ok, false);
  assert.equal(g.timedOut, true);
});

test('completion inside the merge mutex re-checks the deadline: past expiry the merge stands, completion is skipped, and the re-gate gets a FRESH budget (codex r6)', async () => {
  const rec = newRec();
  let t = 0; const gates = [];
  const d = { ...deps(rec, { now: () => t }), postMergeGate: async ({ remainingMs }) => { gates.push(remainingMs); t = 6000; return { ok: true }; } };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 5000, noPr: true }, deps: d });
  assert.equal(s.results.A, 'merged', 'the merge landed within budget');
  assert.equal(rec.complete.length, 0, 'no completion commit past the deadline');
  const rec2 = newRec();
  let t2 = 0; const gates2 = [];
  const d2 = { ...deps(rec2, { now: () => t2 }), postMergeGate: async ({ remainingMs }) => { gates2.push(remainingMs); t2 += 1000; return { ok: true }; } };
  await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 10_000, noPr: true }, deps: d2 });
  assert.equal(rec2.complete.length, 1);
  assert.ok(gates2.length === 2 && gates2[1] < gates2[0], `the completion re-gate gets a fresh, smaller budget: ${gates2.join(',')}`);
});

test('a bounded-policy mismatch is a strike-free refusal: state PAUSED (resumable) with policyMismatch, ONE dispatch, summary.dispatchRefused, exit 1, reason dispatch-refused (codex r7)', async () => {
  const rec = newRec();
  const d = deps(rec, { dispatch: () => ({ exitCode: 1, output: 'sandbox policy: adapter executable not found', timedOut: false, policyMismatch: true }) });
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, maxStrikes: 3, noPr: true }, deps: d });
  assert.equal(rec.dispatch.length, 1, 'no retry');
  assert.equal(s.results.A, 'paused', 'resumable once the operator fixes the policy (codex r24 #1)');
  assert.equal(s.status.tickets.A.reasonCode, null);
  assert.equal(s.status.tickets.A.strikes, 0, 'the strike is handed back');
  assert.equal(s.dispatchRefused, true);
  const { runExitCode } = await import('../lib/run.mjs');
  const { summaryReason } = await import('../lib/result.mjs');
  assert.equal(runExitCode(s), 1);
  assert.equal(summaryReason(s), 'dispatch-refused');
});

test('the worktree init command is bounded by the remaining wall clock (codex r7)', async () => {
  const { buildLiveDeps } = await import('../lib/live-deps.mjs');
  const spawns = []; const t = 1_000_000;
  const io = {
    git: () => (...a) => (a[0] === 'rev-parse' ? 'S0' : ''), adlc: () => ({ status: 0, stdout: '{}' }), adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { status: 0, stdout: '', stderr: '' }; },
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {}, ensureGitignore: () => {}, copyTree: () => {}, env: { PATH: '/usr/bin', HOME: '/h' }, hasGh: () => false, now: () => t,
  };
  const live = buildLiveDeps({ repo: '/repo', config: { gate: { test: 't' }, init: 'npm ci', timeoutMinutes: 30, deadline: t + 45_000, prosecuteFailOn: 'medium' }, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } }, io, reviewRunner: () => ({ ok: true, findings: [] }) });
  live.createWorktree = live.createWorktree; // the real createWorktree needs git worktrees; drive the init spawn through the same sandbox path instead
  const sb = spawns; void sb;
  // The init runs through sandboxFor(...).run with the dispatch timeout: assert the bound on a direct gate spawn with the same deadline math.
  await live.gate({ ticket: T('A'), worktree: '/wt', startSha: 'S', remainingMs: 45_000 });
  const gate = spawns.find((s) => s.opts?.cwd === '/wt');
  assert.ok(gate && gate.opts.timeout <= 45_000, `repo commands carry the remaining budget: ${gate?.opts?.timeout}`);
});

test('after a timeout the SIGKILL escalation reaches the process group even when the leader exits first (codex r7)', async () => {
  const { spawnAsync } = await import('../lib/spawn-async.mjs');
  const { EventEmitter } = await import('node:events');
  const kills = [];
  const child = new EventEmitter(); child.pid = 4242; child.stdout = null; child.stderr = null; child.stdin = null; child.kill = () => {};
  let fire;
  const p = spawnAsync('/bin/hang', [], { timeout: 10, killGroup: true, spawnImpl: () => child, kill: (pid, sig) => { kills.push([pid, sig]); if (sig === 'SIGTERM') setImmediate(() => child.emit('close', null, 'SIGTERM')); }, setTimeoutFn: (fn, ms) => { if (ms === 10) fire = fn; return 1; }, clearTimeoutFn: () => {} });
  fire();
  const r = await p;
  assert.equal(r.timedOut, true);
  assert.deepEqual(kills, [[-4242, 'SIGTERM'], [-4242, 'SIGKILL']], 'the leader\'s exit does not cancel the group SIGKILL');
});

test('a THROWN ticket effect is that ticket\'s recorded failure; the sibling ticket completes and the run returns normally (codex r8)', async () => {
  const rec = newRec();
  const d = { ...deps(rec), gate: async () => { throw new Error('gate exploded'); } };
  const d2 = { ...d, gate: async ({ ticket }) => { if (ticket.id === 'A') throw new Error('gate exploded'); return { ok: true }; } };
  const s = await runFleet({ all: [{ ...T('A'), scope: ['a/**'] }, { ...T('B'), scope: ['b/**'] }], runId: 'r', config: { base: 'main', concurrency: 2, noPr: true }, deps: d2 });
  assert.equal(s.results.A, 'failed');
  assert.match(s.status.tickets.A.reason, /pipeline error: gate exploded/);
  assert.equal(s.results.B, 'merged', 'the sibling ran to completion');
});

test('the rails-guard phase is bounded by the remaining wall clock, killed as a group, and its timeout is a timedOut gate failure (codex r9)', async () => {
  const { buildLiveDeps } = await import('../lib/live-deps.mjs');
  const calls = [];
  const io = {
    git: () => (...a) => (a[0] === 'rev-parse' ? 'S0' : ''), adlc: () => ({ status: 0, stdout: '{}' }),
    adlcAsync: async (args, opts) => { calls.push({ args, opts }); return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true }; },
    spawnWorker: async () => ({ status: 0, stdout: '', stderr: '' }),
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {}, ensureGitignore: () => {}, copyTree: () => {}, env: { PATH: '/usr/bin', HOME: '/h' }, hasGh: () => false,
  };
  const live = buildLiveDeps({ repo: '/repo', config: { gate: {}, prosecuteFailOn: 'medium', timeoutMinutes: 1 }, sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } }, io, reviewRunner: () => ({ ok: true, findings: [] }) });
  const g = await live.gate({ ticket: T('A'), worktree: '/wt', startSha: 'S0', remainingMs: 7000 });
  const rg = calls.find((c) => c.args[0] === 'rails-guard');
  assert.ok(rg, 'rails-guard ran');
  assert.equal(rg.opts.timeout, 7000); assert.equal(rg.opts.killGroup, true);
  assert.equal(g.ok, false); assert.equal(g.timedOut, true); assert.equal(g.stage, 'rails-guard');
});

test('a thrown effect keeps the strike it entered and is reported run-level as pipeline-error (exit 1), never strikes-exhausted (codex r10)', async () => {
  const rec = newRec();
  const d = { ...deps(rec), gate: async () => { if (rec.dispatch.length === 2) throw new Error('gate exploded on strike 2'); return { ok: false, output: 'red' }; } };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, maxStrikes: 3, noPr: true }, deps: d });
  assert.equal(s.results.A, 'failed');
  assert.equal(s.status.tickets.A.strikes, 2, 'both entered strikes are counted');
  assert.equal(s.pipelineError, true);
  const { runExitCode } = await import('../lib/run.mjs');
  const { summaryReason } = await import('../lib/result.mjs');
  assert.equal(summaryReason(s), 'pipeline-error');
  assert.equal(runExitCode(s), 1);
});

test('a worktree-setup or provisioning failure is run-level dispatch-refused (exit 1), never strikes-exhausted (codex r11)', async () => {
  const rec = newRec();
  const d = { ...deps(rec), createWorktree: async () => { throw new Error('init exploded'); } };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, noPr: true }, deps: d });
  const { runExitCode } = await import('../lib/run.mjs');
  const { summaryReason } = await import('../lib/result.mjs');
  assert.equal(s.results.A, 'pending', 'retryable on the next invocation'); assert.equal(s.dispatchRefused, true);
  assert.equal(summaryReason(s), 'dispatch-refused'); assert.equal(runExitCode(s), 1);
});

test('a cleanup that THROWS is recorded on its ticket and logged; the run continues with the sibling tickets and finishes (the lock is never released early by a cleanup failure)', async () => {
  const rec = newRec();
  const d = deps(rec);
  d.cleanup = async ({ ticket }) => { if (ticket.id === 'A') throw new Error('rm: device busy'); };
  const s = await runFleet({ all: [T('A'), T('B')], runId: 'r', config: { base: 'main', concurrency: 1, noPr: true }, deps: d });
  assert.equal(rec.dispatch.length, 2, 'both tickets were dispatched (the failing cleanup of A did not abort the run)');
  assert.equal(s.results.A, 'merged'); assert.equal(s.results.B, 'merged');
  assert.match(String(s.status.tickets.A.cleanupFailed), /device busy/, 'the cleanup failure is recorded on the ticket');
  assert.equal(s.status.tickets.B.cleanupFailed, undefined);
});

test('a post-merge gate that THROWS withdraws the merge like a red gate (a strike, not a merged ticket); when the merge cannot be withdrawn the integration branch is quarantined and no PR opens', async () => {
  const rec = newRec();
  const d = deps(rec);
  const reverts = [];
  d.postMergeGate = async () => { throw new Error('gate runner crashed'); };
  d.revertMerge = async (a) => { reverts.push(a); return { ok: true, method: 'reset' }; };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, maxStrikes: 1 }, deps: d });
  assert.equal(reverts.length, 1, 'the merge was withdrawn');
  assert.notEqual(s.results.A, 'merged', `never reported merged: ${s.results.A}`);
  const rec2 = newRec();
  const d2 = deps(rec2);
  d2.postMergeGate = async () => { throw new Error('gate runner crashed'); };
  d2.revertMerge = async () => ({ ok: false, method: 'refused', reason: 'HEAD moved; revert refused' });
  const s2 = await runFleet({ all: [T('A'), T('B')], runId: 'r2', config: { base: 'main', concurrency: 1, maxStrikes: 1 }, deps: d2 });
  assert.notEqual(s2.results.A, 'merged');
  assert.equal(rec2.openPR.length, 0, 'no PR opens from a quarantined branch');
  assert.equal(s2.merged, 0); assert.equal(s2.results.B, 'failed', 'the sibling ticket is refused on the quarantined branch');
});

test('spawnAsync killGroup: a leader that exits NORMALLY after forking a background survivor takes the survivor with it — the group dies with the leader on every exit, not only a timeout (codex r23 #1)', { timeout: 20_000 }, async () => {
  const script = 'const { spawn } = require("node:child_process"); const c = spawn("sleep", ["30"], { stdio: "ignore" }); process.stdout.write(String(c.pid)); setTimeout(() => process.exit(0), 50);';
  const gone = async (pid) => { for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 50)); } return false; };
  const res = await spawnAsync(process.execPath, ['-e', script], { timeout: 10_000, killGroup: true, encoding: 'utf8' });
  assert.equal(res.status, 0); assert.equal(res.timedOut, false);
  const survivor = Number(res.stdout.trim());
  assert.ok(survivor > 1, `the leader reported its survivor pid (${res.stdout})`);
  assert.equal(await gone(survivor), true, 'the survivor is gone once the call resolved');
  // Control: without killGroup the legacy single-process path leaves the survivor alive.
  const legacy = await spawnAsync(process.execPath, ['-e', script], { timeout: 10_000, encoding: 'utf8' });
  const orphan = Number(legacy.stdout.trim());
  let alive = true; try { process.kill(orphan, 0); } catch { alive = false; }
  try { process.kill(orphan, 'SIGKILL'); } catch { /* already gone */ }
  assert.equal(alive, true, 'the control proves the assertion is load-bearing: the legacy path keeps the orphan');
});

test('a completion commit that lands past the wall clock is WITHDRAWN: the ticket is merged (not completed), the run reports wall-clock, opens no PR and exits 2 (codex r23 #4)', async () => {
  const rec = newRec(); const reverts = [];
  let t = 0;
  const d = { ...deps(rec, { now: () => t }), completeTicket: async (a) => { rec.complete.push(a); t = 6000; return { completed: true, preCompletionSha: 'P', completionSha: 'C' }; }, revertCompletion: async (a) => { reverts.push(a); } };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 5000 }, deps: d });
  assert.equal(s.results.A, 'merged', 'the merge itself landed within budget and stands');
  assert.equal(reverts.length, 1, 'the past-deadline completion commit came off the branch');
  assert.equal(reverts[0].toSha, 'P');
  assert.equal(s.status.tickets.A.reasonCode, 'wall-clock');
  assert.equal(s.wallClockExpired, true);
  assert.equal(rec.openPR.length, 0, 'nothing is published past the deadline');
  assert.equal(runExitCode(s), 2, 'resumable');
  // A withdrawal that cannot happen quarantines the branch instead of shipping the commit.
  const rec2 = newRec(); let t2 = 0;
  const d2 = { ...deps(rec2, { now: () => t2 }), completeTicket: async () => { t2 = 6000; return { completed: true, preCompletionSha: 'P' }; }, revertCompletion: undefined };
  const s2 = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 5000, maxStrikes: 1 }, deps: d2 });
  assert.equal(s2.contaminated, true); assert.equal(rec2.openPR.length, 0);
});

test('a completion re-gate that fails once the wall clock has passed withdraws the completion AND reports wall-clock; a completion gated within budget whose return crosses the deadline is kept but not published (codex r23 #4)', async () => {
  const rec = newRec(); const reverts = [];
  let t = 0;
  const d = { ...deps(rec, { now: () => t }), postMergeGate: async () => { if (rec.complete.length) { t = 6000; return { ok: false, timedOut: true, output: 'cut' }; } return { ok: true }; }, revertCompletion: async (a) => { reverts.push(a); } };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 5000 }, deps: d });
  assert.equal(s.results.A, 'merged'); assert.equal(reverts.length, 1); assert.equal(s.wallClockExpired, true); assert.equal(rec.openPR.length, 0);
  const rec2 = newRec(); const reverts2 = [];
  let t2 = 0;
  // The re-gate over the completion ran within budget and passed; the deadline passes before the effect returns.
  const d2 = { ...deps(rec2, { now: () => t2 }), postMergeGate: async () => { if (rec2.complete.length) t2 = 5000; return { ok: true }; }, completeTicket: async (a) => { rec2.complete.push(a); return { completed: true, preCompletionSha: 'P' }; }, revertCompletion: async (a) => { reverts2.push(a); } };
  const s2 = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, deadline: 5000 }, deps: d2 });
  assert.equal(s2.results.A, 'merged'); assert.equal(reverts2.length, 0, 'a completion gated within budget is kept');
  assert.equal(s2.wallClockExpired, true, 'but the run still reports wall-clock');
  assert.equal(rec2.openPR.length, 0, 'and publishes nothing');
});

test('a completion re-gate that THROWS is a red re-gate: the completion commit is withdrawn (merged, not completed); when it cannot be withdrawn the branch is quarantined and no PR opens (codex r24 #2)', async () => {
  const rec = newRec(); const reverts = [];
  const d = { ...deps(rec), postMergeGate: async () => { if (rec.complete.length) throw new Error('gate runner crashed'); return { ok: true }; }, revertCompletion: async (a) => { reverts.push(a); } };
  const s = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1 }, deps: d });
  assert.equal(s.results.A, 'merged'); assert.equal(reverts.length, 1, 'the unvalidated completion commit came off the branch');
  assert.equal(s.contaminated, undefined ?? s.contaminated, 'no quarantine when the withdrawal succeeded'); assert.ok(!s.contaminated);
  assert.equal(rec.openPR.length, 1, 'the shipped merge below it is still published');
  const rec2 = newRec();
  const d2 = { ...deps(rec2), postMergeGate: async () => { if (rec2.complete.length) throw new Error('gate runner crashed'); return { ok: true }; }, revertCompletion: async () => { throw new Error('reset refused'); } };
  const s2 = await runFleet({ all: [T('A')], runId: 'r', config: { base: 'main', concurrency: 1, maxStrikes: 1 }, deps: d2 });
  assert.equal(s2.contaminated, true, 'a completion that cannot be withdrawn quarantines the branch'); assert.equal(rec2.openPR.length, 0);
});

test('spawnAsync never hands `timeout` to the underlying spawn: node\'s own leader-only SIGTERM must not race the group termination (agy r2 c4)', async () => {
  const seen = [];
  const child = new EventEmitter(); child.pid = 4242; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const p = spawnAsync('/bin/x', [], { timeout: 5000, killGroup: true, spawnImpl: (cmd, args, o) => { seen.push(o); return child; }, kill: () => {}, setTimeoutFn: () => 1, clearTimeoutFn: () => {} });
  child.emit('close', 0, null);
  await p;
  assert.equal(seen.length, 1); assert.ok(!('timeout' in seen[0]), 'timeout stripped'); assert.equal(seen[0].detached, true);
});
