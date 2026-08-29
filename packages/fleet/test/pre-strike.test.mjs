// fleet-ext item 7 / AC3 + AC4: the pre-strike helper is executed with an argv
// ARRAY and shell:false, with EXACTLY the operator-supplied environment (the
// ledger key can never leak into it), before every strike; a refusal pauses the
// run so an IDENTICAL re-invocation resumes it through the existing status
// reconciliation — there is no --resume flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLiveDeps } from '../lib/live-deps.mjs';
import { runFleet } from '../lib/run.mjs';
import { reconcileRun } from '../lib/resume.mjs';
import { loadStatus } from '../lib/status.mjs';
import { findInner, unwrapAll } from './helpers/worker-calls.mjs';

const ORCHESTRATOR_ENV = { PATH: '/usr/bin:/repo/node_modules/.bin', HOME: '/home/op', ADLC_MANIFEST_KEY: 'super-secret', GH_TOKEN: 'ghp_x', FOO_SECRET: 's' };
const PRE_STRIKE_ARGV = ['/opt/adlc/bin/adlc', 'autopilot', 'quota', '--json', '--model', 'opus;touch /tmp/x', '--quota-threshold', '50'];
const PRE_STRIKE_ENV = { PATH: '/usr/bin', HOME: '/home/op', ADLC_AUTOPILOT_STATUS_FILE: '/repo/.adlc/autopilot-status.json', ADLC_AUTOPILOT_LOCK_TOKEN: 'tok' };
const ticket = { id: 'T1', title: 'T1', scope: ['packages/x/**'], body: 'do', edges: [] };

function fakeIo(rec, { preStrikeStatus = 0 } = {}) {
  return {
    git: () => (...args) => { rec.git.push(args); return args[0] === 'rev-parse' ? 'SHA' : ''; },
    adlc: () => ({ status: 0, stdout: '{"verdict":"clean","signals":[]}' }),
    adlcAsync: async () => ({ status: 0, stdout: '' }),
    spawnWorker: async (cmd, args, opts) => {
      rec.spawn.push({ cmd, args, opts });
      if (cmd === PRE_STRIKE_ARGV[0]) return { status: preStrikeStatus, stdout: '', stderr: preStrikeStatus ? 'quota 52% used' : '' };
      return { status: 0, stdout: 'TICKET-DONE', stderr: '' };
    },
    readFile: () => '', exists: () => false, mkdirp: () => {}, writeJson: () => {}, appendLog: () => {}, ensureGitignore: () => {},
    copyTree: () => {}, env: ORCHESTRATOR_ENV, hasGh: () => false,
  };
}
const newRec = () => ({ spawn: [], git: [] });
const config = { gate: { test: 'npm test' }, prosecuteFailOn: 'medium', timeoutMinutes: 1, preStrikeArgv: PRE_STRIKE_ARGV, preStrikeEnv: PRE_STRIKE_ENV, maxStrikes: 2, noPr: true, noComplete: true };
const sandboxSpec = { mode: 'sandbox', backend: { name: 'bubblewrap' } };

test('AC3: the helper is spawned with an argv array, shell:false, a metachar element intact, and EXACTLY the given env', async () => {
  const rec = newRec();
  const deps = buildLiveDeps({ repo: '/repo', config, sandboxSpec, io: fakeIo(rec), reviewRunner: () => ({ ok: true, findings: [] }) });
  const r = await deps.preStrike({ ticket, strike: 1 });
  assert.deepEqual(r, { ok: true });
  const call = rec.spawn.find((c) => c.cmd === PRE_STRIKE_ARGV[0]);
  assert.ok(call, 'the helper was spawned by its ABSOLUTE path');
  assert.deepEqual(call.args, PRE_STRIKE_ARGV.slice(1), 'argv elements verbatim — the shell metacharacters are ONE element');
  assert.equal(call.opts.shell, false, 'no shell, ever');
  assert.deepEqual(call.opts.env, PRE_STRIKE_ENV, 'the environment is exactly the operator-supplied object');
  assert.equal(call.opts.env.ADLC_MANIFEST_KEY, undefined, 'the ledger key is absent');
  assert.equal(call.opts.env.GH_TOKEN, undefined, 'and so is every other orchestrator secret');
  assert.equal(rec.spawn.filter((c) => c.cmd === 'bwrap').length, 0, 'the helper runs on the host, not in a sandbox');
});

test('a non-zero helper exit pauses the ticket with quota-paused: zero worker dispatches, status persisted, exit reason resumable', async () => {
  const rec = newRec();
  const dir = mkdtempSync(join(tmpdir(), 'fleet-prestrike-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', config, statusDir: dir, sandboxSpec, io: fakeIo(rec, { preStrikeStatus: 3 }), reviewRunner: () => ({ ok: true, findings: [] }) });
    const s = await runFleet({ all: [ticket], runId: 'run-1', config: { ...config, base: 'main', concurrency: 1, baseSha: 'B' }, deps: { ...deps, createIntegrationBranch: async () => {}, createWorktree: async () => ({ path: '/wt', branch: 'fleet/t1', startSha: 'B' }), provision: () => {}, cleanup: () => {}, statusDir: dir } });
    assert.equal(s.results.T1, 'paused');
    assert.equal(s.status.tickets.T1.reasonCode, 'quota-paused');
    assert.match(s.status.tickets.T1.reason, /quota 52%/);
    assert.equal(findInner(rec.spawn, 'claude'), undefined, 'no worker was dispatched');
    const persisted = loadStatus(dir);
    assert.equal(persisted.tickets.T1.state, 'paused');
    assert.equal(persisted.runId, 'run-1');
    // AC4: an identical re-invocation reconciles the persisted status: paused → pending, strikes kept, same runId.
    const rec2 = reconcileRun({ all: [ticket], status: persisted, repo: '/repo', io: { git: () => (...a) => (a[0] === 'merge-base' ? (() => { throw new Error('no'); })() : '') } });
    assert.equal(rec2.resume, true);
    assert.equal(rec2.status.tickets.T1.state, 'pending');
    assert.equal(rec2.status.tickets.T1.strikes, 0);
    assert.equal(rec2.status.runId, 'run-1', 'the resumed run keeps its fleetRunId');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('AC4 end-to-end: run 1 pauses at strike 2, run 2 (identical invocation, reconciled status) resumes from strike 1 and finishes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-resume-'));
  try {
    // Run 1: strike 1 fails the build, strike 2 is refused by the helper.
    const rec1 = newRec();
    let helperCalls = 0;
    const io1 = fakeIo(rec1);
    io1.spawnWorker = async (cmd, args, opts) => {
      rec1.spawn.push({ cmd, args, opts });
      if (cmd === PRE_STRIKE_ARGV[0]) return { status: ++helperCalls === 2 ? 1 : 0, stdout: '', stderr: 'quota' };
      return { status: 1, stdout: 'build failed', stderr: '' };
    };
    // The git/merge choreography is stubbed: this test is about the PAUSE and the
    // RESUME, and the fake git cannot answer the integration worktree's branch checks.
    const base = (_rec, io) => ({
      ...buildLiveDeps({ repo: '/repo', config, statusDir: dir, sandboxSpec, io, reviewRunner: () => ({ ok: true, findings: [] }) }),
      createIntegrationBranch: async () => {}, ensureIntegrationWorktree: async () => {},
      createWorktree: async () => ({ path: '/wt', branch: 'fleet/t1', startSha: 'B' }), provision: () => {}, cleanup: () => {},
      mergeToIntegration: async () => ({ mergeSha: 'M', preMergeSha: 'P' }), postMergeGate: async () => ({ ok: true }), revertMerge: async () => ({ ok: true, method: 'reset' }),
      statusDir: dir,
    });
    const s1 = await runFleet({ all: [ticket], runId: 'run-1', config: { ...config, base: 'main', concurrency: 1, baseSha: 'B', maxStrikes: 2 }, deps: base(rec1, io1) });
    assert.equal(s1.results.T1, 'paused');
    assert.equal(s1.status.tickets.T1.strikes, 1, 'strike 1 was consumed before the pause');
    assert.equal(s1.strikesConsumed, 1);
    // Run 2: the status on disk is reconciled (git says nothing merged) and the run continues.
    const persisted = loadStatus(dir);
    const rec2 = reconcileRun({ all: [ticket], status: persisted, repo: '/repo', io: { git: () => (...a) => (a[0] === 'merge-base' ? (() => { throw new Error('no'); })() : '') } });
    const rec2spawn = newRec();
    const io2 = fakeIo(rec2spawn);
    const s2 = await runFleet({ all: [ticket], runId: 'ignored-when-resuming', resume: { status: rec2.status, integrationBranch: rec2.status.integrationBranch }, config: { ...config, base: 'main', concurrency: 1, baseSha: 'B', maxStrikes: 2 }, deps: base(rec2spawn, io2) });
    assert.equal(s2.results.T1, 'merged');
    assert.equal(s2.status.runId, 'run-1', 'same fleetRunId');
    assert.equal(s2.status.tickets.T1.strikes, 2, 'strike 2 was the ONLY strike of run 2');
    assert.equal(s2.strikesConsumed, 1);
    // Count the INNER claude spawns: the gate commands also run under bwrap, so
    // counting wrappers would count the gate as a dispatch.
    const workers = unwrapAll(rec2spawn.spawn).filter((c) => c.cmd === 'claude');
    assert.equal(workers.length, 1, 'exactly one worker dispatch in the resumed run');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no preStrikeArgv → no preStrike effect at all (legacy runs are byte-identical)', () => {
  const deps = buildLiveDeps({ repo: '/repo', config: { gate: { test: 't' } }, sandboxSpec, io: fakeIo(newRec()) });
  assert.equal(deps.preStrike, undefined);
});

test('the pre-strike spawn kills its process group on timeout and is bounded by the REMAINING wall clock, never more than its 120 s maximum (codex r4)', async () => {
  const rec = newRec();
  const t = 1_000_000;
  const deps = buildLiveDeps({ repo: '/repo', config: { ...config, deadline: t + 30_000 }, sandboxSpec, io: { ...fakeIo(rec), now: () => t }, reviewRunner: () => ({ ok: true, findings: [] }) });
  await deps.preStrike({ ticket, strike: 1 });
  const spawn = rec.spawn.find((s) => s.cmd === PRE_STRIKE_ARGV[0]);
  assert.equal(spawn.opts.killGroup, true, 'the helper is spawned in its own process group');
  assert.equal(spawn.opts.timeout, 30_000, 'the timeout is the remaining budget');
  const rec2 = newRec();
  const far = buildLiveDeps({ repo: '/repo', config: { ...config, deadline: t + 10 * 60_000 }, sandboxSpec, io: { ...fakeIo(rec2), now: () => t }, reviewRunner: () => ({ ok: true, findings: [] }) });
  await far.preStrike({ ticket, strike: 1 });
  assert.equal(rec2.spawn.find((s) => s.cmd === PRE_STRIKE_ARGV[0]).opts.timeout, 120_000, 'capped at the helper maximum');
  // every repo-command (gate) spawn kills its group too
  const rec3 = newRec();
  const g = buildLiveDeps({ repo: '/repo', config, sandboxSpec, io: fakeIo(rec3), reviewRunner: () => ({ ok: true, findings: [] }) });
  await g.gate({ ticket, worktree: '/wt', startSha: 'S' }).catch(() => {});
  const gateSpawn = rec3.spawn.find((s) => s.opts?.cwd === '/wt');
  assert.ok(gateSpawn, 'a gate command was spawned');
  assert.equal(gateSpawn.opts.killGroup, true, 'gate commands are spawned in their own process group');
});

test('the pre-strike helper is spawned with a 1 MiB per-stream output budget (its result is a status line, never an unbounded transcript)', async () => {
  const { PRE_STRIKE_MAX_OUTPUT_BYTES } = await import('../lib/live-deps.mjs');
  const rec = newRec();
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-prestrike-cap-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', config, statusDir, sandboxSpec, reviewRunner: null, seats: null, io: fakeIo(rec) });
    const r = await deps.preStrike({ ticket, strike: 1 });
    assert.equal(r.ok, true);
    const spawn = rec.spawn.find((x) => x.cmd === PRE_STRIKE_ARGV[0]);
    assert.ok(spawn, 'the helper was spawned');
    assert.equal(spawn.opts.maxOutputBytes, PRE_STRIKE_MAX_OUTPUT_BYTES, 'the budget is passed to the spawn');
    assert.equal(PRE_STRIKE_MAX_OUTPUT_BYTES, 1024 * 1024);
  } finally { rmSync(statusDir, { recursive: true, force: true }); }
});

test('the host-side commit of the worker output runs git with the host-safe overrides (fs monitor, hook path and ssh command disabled) on every invocation', async () => {
  const { HOST_SAFE_GIT_FLAGS } = await import('../lib/git-mirror.mjs');
  const rec = newRec();
  const statusDir = mkdtempSync(join(tmpdir(), 'fleet-hostsafe-'));
  try {
    const deps = buildLiveDeps({ repo: '/repo', config, statusDir, sandboxSpec, reviewRunner: null, seats: null, io: fakeIo(rec) });
    await deps.dispatch({ ticket, worktree: '/repo/.worktrees/fleet-T1', strike: 1, branch: 'fleet/t1' });
    const commitCalls = rec.git.filter((args) => args.includes('commit') || args.includes('add'));
    assert.ok(commitCalls.length >= 2, `add + commit ran: ${JSON.stringify(rec.git).slice(0, 300)}`);
    for (const args of commitCalls) assert.deepEqual(args.slice(0, HOST_SAFE_GIT_FLAGS.length), [...HOST_SAFE_GIT_FLAGS], `host-safe overrides lead the argv: ${JSON.stringify(args)}`);
  } finally { rmSync(statusDir, { recursive: true, force: true }); }
});
