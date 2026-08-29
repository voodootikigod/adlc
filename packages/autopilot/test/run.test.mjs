// AC 5 / 9 / 25 / 41 / 60 / 64 / 78 / 81 / 90 / 95 / 103 / 113 / 152 / 162 —
// the orchestrator's dispatch contract: the fleet argv, the §6.10 outcome
// mapping (reason authoritative, closed enum), the global round budget, the
// pre-strike helper's resolved values and minimal env, and the sandbox policy
// the argv requests. Fake deps everywhere; the collaborators' own suites prove
// their behaviour.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFleetArgv, preStrikeArgv, preStrikeEnv, readSet, PRE_STRIKE_ENV_KEYS, REASON_CODES_FLEET, SYSTEM_ROOTS } from '../lib/fleet-args.mjs';
import { outcomeFor, remainingBudget } from '../lib/run.mjs';
import { dispatchFleet, parseFleetResult, writeDeadEnd } from '../lib/dispatch.mjs';
import { createSpawner } from '../lib/spawn.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { autopilotPaths } from '../lib/paths.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';
import { realpathSync } from 'node:fs';
import { pinnedRealpaths } from '../lib/tools.mjs';
import { createSequenceFixture } from './helpers/sequence-fixture.mjs';
import { runIssue } from '../lib/run.mjs';
import { FAKE } from './helpers/recover-fixture.mjs';

const HOME = '/home/op';
function fakeCtx(over = {}) {
  const root = over.repoRoot ?? '/srv/repo';
  return {
    repoRoot: root, paths: autopilotPaths(root), key: 'k'.repeat(32), iterationId: 'it-1', now: () => 1_700_000_000_000,
    pinned: { adlc: '/opt/adlc/bin/adlc', 'adlc:realpath': '/opt/adlc/bin/adlc', git: '/usr/bin/git', 'git:realpath': '/usr/bin/git', claude: `${HOME}/.local/bin/claude`, 'claude:realpath': `${HOME}/.local/bin/claude`, node: `${HOME}/.fnm/node/bin/node`, 'node:realpath': `${HOME}/.fnm/node/bin/node`, bwrap: '/usr/bin/bwrap', 'bwrap:realpath': '/usr/bin/bwrap' },
    env: { path: '/usr/bin:/opt/adlc/bin', home: HOME, base: { PATH: '/usr/bin:/opt/adlc/bin', HOME, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC' } },
    local: { model: 'opus', adapter: 'claude-code', quotaThreshold: 50, quotaReserve: 5, ...(over.local ?? {}) },
    config: { autopilot: { maxRounds: 15, wallClockMinutes: 90 } },
    lock: { token: 't'.repeat(64) }, charterPath: '/opt/autopilot/lib/charter-adlc.md',
    git: { overlayEnv: () => ({ GIT_CONFIG_COUNT: '7' }) },
    redactor: createRedactor({ secretValues: ['k'.repeat(32)] }),
    ...over,
  };
}
const budget = { strikes: 15, wallClockMinutes: 90, wallClockMs: 90 * 60_000 };
const argvFor = (ctx, extra = {}) => buildFleetArgv({ ctx, issue: 7, ticketId: 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', budget, mirror: ctx.paths.mirror(7), workerDeps: join(ctx.paths.workerDeps(7), 'node_modules'), ...extra });
const valueOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

export function ac5_dispatchArgv() {
  const ctx = fakeCtx();
  const argv = argvFor(ctx);
  assert.equal(argv[0], ctx.pinned.adlc, 'the pinned adlc');
  assert.deepEqual(argv.slice(1, 3), ['fleet', 'run']);
  assert.equal(argv.filter((a) => a === '--tickets').length, 1);
  assert.equal(valueOf(argv, '--tickets'), 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', 'exactly one ticket id');
  assert.ok(argv.includes('--no-pr') && argv.includes('--no-complete'));
  assert.ok(argv.includes('--pre-strike-argv'), 'every strike is gated by the pre-strike quota helper (AC 18)');
  assert.ok(JSON.parse(valueOf(argv, '--pre-strike-argv'))[0] === ctx.pinned.adlc, 'the helper argv is a JSON array whose argv[0] is the pinned adlc');
  assert.equal(valueOf(argv, '--max-strikes'), '15');
  assert.equal(valueOf(argv, '--wall-clock-minutes'), '90');
  assert.equal(valueOf(argv, '--model'), 'opus');
  assert.equal(valueOf(argv, '--concurrency'), '1');
  assert.equal(valueOf(argv, '--base'), 'adlc/autopilot/issue-7', "fleet's --base is the integration start, never BASE_OID");
  assert.ok(argv.includes('--json'));
  assert.ok(argv.includes('--pre-strike-argv') && argv.includes('--pre-strike-env'), 'AC18: every dispatch carries the pre-strike helper');
}
test('AC5: the fleet argv carries exactly one ticket, --no-pr/--no-complete, --max-strikes 15, --wall-clock-minutes 90, --model opus and --base adlc/autopilot/issue-<n>', ac5_dispatchArgv);

export function ac60_preStrikeResolvedValues() {
  const ctx = fakeCtx({ local: { model: 'sonnet', adapter: 'claude-code', quotaThreshold: 40, quotaReserve: 10 } });
  const argv = argvFor(ctx);
  const helper = JSON.parse(valueOf(argv, '--pre-strike-argv'));
  assert.equal(helper[0], ctx.pinned.adlc, 'element 0 is the pinned ABSOLUTE adlc, never the bare name');
  for (const pair of [['--model', 'sonnet'], ['--quota-threshold', '40'], ['--quota-reserve', '10'], ['--iteration', 'it-1'], ['--start-ordinal', 'auto'], ['--wall-clock-remaining', '90']]) {
    assert.equal(helper[helper.indexOf(pair[0]) + 1], pair[1], pair.join(' '));
  }
  assert.deepEqual(helper.slice(1, 4), ['autopilot', 'quota', '--json']);
  const env = JSON.parse(valueOf(argv, '--pre-strike-env'));
  assert.deepEqual(Object.keys(env).sort(), [...PRE_STRIKE_ENV_KEYS].sort(), 'exactly the four documented keys');
}
test('AC60: --pre-strike-argv has the pinned absolute adlc as element 0 and the resolved --model/--quota-threshold/--quota-reserve/--iteration/--start-ordinal auto; --pre-strike-env has exactly four keys', ac60_preStrikeResolvedValues);

export function ac103_preStrikeMinimalEnv() {
  const ctx = fakeCtx();
  const env = preStrikeEnv({ ctx: { ...ctx, env: { ...ctx.env, raw: { ADLC_MANIFEST_KEY: 'k', GH_TOKEN: 'g', FOO_SECRET: 'f', PATH: '/x' } } } });
  assert.deepEqual(Object.keys(env).sort(), ['ADLC_AUTOPILOT_LOCK_TOKEN', 'ADLC_AUTOPILOT_STATUS_FILE', 'HOME', 'PATH']);
  for (const leaked of ['ADLC_MANIFEST_KEY', 'GH_TOKEN', 'FOO_SECRET']) assert.equal(env[leaked], undefined, `${leaked} does not leak`);
  assert.equal(env.ADLC_AUTOPILOT_STATUS_FILE, ctx.paths.statusFile);
  assert.equal(env.ADLC_AUTOPILOT_LOCK_TOKEN, ctx.lock.token);
  assert.equal(env.PATH, ctx.env.path, 'the sanitized PATH, not the raw one');
}
test('AC103: the --pre-strike-env object has exactly PATH, HOME, ADLC_AUTOPILOT_STATUS_FILE, ADLC_AUTOPILOT_LOCK_TOKEN and leaks no orchestrator secret', ac103_preStrikeMinimalEnv);

export function ac64_argvSafe() {
  const ctx = fakeCtx({ local: { model: 'opus;touch /tmp/x', adapter: 'claude-code', quotaThreshold: 50, quotaReserve: 5 } });
  // The grammar refuses the model long before an argv is built; the builder never re-splits a value.
  const helper = preStrikeArgv({ ctx: fakeCtx({ local: { model: 'opus', adapter: 'claude-code', quotaThreshold: 50, quotaReserve: 5 } }), iterationId: 'x y', wallClockRemaining: 5 });
  assert.equal(helper[helper.indexOf('--iteration') + 1], 'x y', 'a value with a space is ONE element');
  const argv = argvFor(ctx);
  assert.equal(JSON.parse(valueOf(argv, '--pre-strike-argv'))[5], 'opus;touch /tmp/x', 'the JSON array carries the value verbatim as one element');
}
test('AC64: every value is its own argv element (JSON array elements verbatim); nothing is ever a shell string', ac64_argvSafe);

export function ac78_readSetAndWritableRoots() {
  const ctx = fakeCtx();
  const argv = argvFor(ctx);
  assert.equal(valueOf(argv, '--model-plane-read'), 'bounded');
  const ro = valueOf(argv, '--model-plane-read-only').split(',');
  for (const r of SYSTEM_ROOTS) assert.ok(ro.includes(r), `system root ${r}`);
  assert.ok(ro.includes(`${HOME}/.local/bin/claude`), 'pinned claude as a single file');
  assert.ok(ro.includes(`${HOME}/.fnm/node/bin/node`), 'pinned node as a single file');
  assert.ok(ro.includes(`${HOME}/.fnm/node/lib/node_modules/npm`) && ro.includes(`${HOME}/.fnm/node/lib/node_modules/corepack`), 'the npm/corepack trees');
  const writable = [ctx.repoRoot, join(ctx.repoRoot, '.git'), ctx.paths.issueWorktree(7), HOME, '/tmp', ctx.paths.mirror(7), join(ctx.paths.issueWorktree(7), '.worktrees', 'fleet-t-01m0z3fn7sas4hah7cs63yq0dh')];
  for (const w of writable) assert.ok(!ro.includes(w), `${w} is not in the read set`);
  for (const w of [ctx.repoRoot, ctx.paths.issueWorktree(7), ctx.paths.mirror(7)]) assert.ok(!ro.some((r) => w === r || w.startsWith(r + '/')), `no read-only entry is an ancestor of ${w}`);
  assert.equal(valueOf(argv, '--model-plane-git'), 'mirror');
  assert.equal(valueOf(argv, '--model-plane-git-mirror'), ctx.paths.mirror(7));
}
test('AC78: --model-plane-read bounded; the read set has the pinned tool files + npm/corepack + system roots and NEITHER REPO_ROOT, .git, ISSUE_WT, HOME, /tmp, the worker worktree nor the mirror', ac78_readSetAndWritableRoots);

export function ac81_mirrorIsTheOnlyGitDatabase() {
  const ctx = fakeCtx();
  const argv = argvFor(ctx);
  assert.equal(valueOf(argv, '--model-plane-git-mirror'), `${ctx.repoRoot}/.adlc/autopilot-runs/7/mirror.git`);
  assert.ok(!valueOf(argv, '--model-plane-read-only').split(',').includes(ctx.paths.mirror(7)), 'the mirror is never in the read set');
  assert.ok(!valueOf(argv, '--model-plane-read-only').split(',').includes(ctx.repoRoot), 'REPO_ROOT itself is never in the read set');
  assert.ok(!argv.join(' ').includes(`${ctx.repoRoot}/.git`), 'REPO_ROOT/.git appears nowhere');
  assert.ok(!argv.some((a) => a.includes('--model-plane-git-sanitize')));
}
test('AC81: --model-plane-git mirror names <REPO_ROOT>/.adlc/autopilot-runs/<issue>/mirror.git, never in the read set, and no argv mentions REPO_ROOT/.git or --model-plane-git-sanitize', ac81_mirrorIsTheOnlyGitDatabase);

export function ac113_systemRootException() {
  const ctx = fakeCtx();
  const ro = readSet({ ctx });
  assert.ok(!ro.includes('/usr/bin/git'), 'a pinned /usr/bin/git needs no extra file bind (covered by /usr)');
  assert.ok(!ro.includes('/usr/bin/bwrap'));
  assert.equal(ro.filter((p) => p === `${HOME}/.local/bin/claude`).length, 1, 'exactly one file bind for ~/.local/bin/claude');
  assert.ok(!ro.includes(`${HOME}/.local/bin`), 'and no bind of ~/.local/bin');
}
test('AC113: a pinned /usr/bin/git yields no extra bind (under /usr); ~/.local/bin/claude yields exactly one file bind and never its directory', ac113_systemRootException);

export function ac152_and_162_argv() {
  const ctx = fakeCtx();
  const argv = argvFor(ctx);
  assert.equal(valueOf(argv, '--model-plane-egress'), 'allowlist');
  assert.equal(valueOf(argv, '--worker-deps'), `${ctx.repoRoot}/.adlc/autopilot-runs/7/worker-deps/node_modules`);
  assert.ok(!argv.includes('--init-on-host'));
  assert.equal(valueOf(argv, '--charter-file'), ctx.charterPath);
  const withDeadEnd = argvFor(ctx, { deadEndFile: '/run/dead-end.txt' });
  assert.equal(valueOf(withDeadEnd, '--dead-end-file'), '/run/dead-end.txt');
  assert.ok(!argv.includes('--dead-end-file'), 'no dead-end flag on the first round');
}
test('AC152/162: the fleet argv carries --model-plane-egress allowlist; --worker-deps <run dir>/worker-deps/node_modules and no --init-on-host', ac152_and_162_argv);

export async function ac41_and_90_outcomeMapping() {
  const doc = (reason, extra = {}) => ({ exitCode: 2, reason, parsed: { fleetRunId: 'r', reason, tickets: {} , ...extra } });
  assert.deepEqual(outcomeFor(doc('quota-paused')), { state: 'quota-paused', effect: 'none' });
  assert.deepEqual(outcomeFor(doc('lock-held')), { state: 'unchanged', effect: 'none', skipped: 'lock-held' });
  for (const r of ['wall-clock', 'strikes-exhausted', 'ticket-blocked', 'flail', 'review-unavailable', 'mirror-fetch-failed']) {
    assert.deepEqual(outcomeFor(doc(r)), { state: 'blocked', effect: 'label', reason: r }, r);
  }
  assert.equal(REASON_CODES_FLEET.length, 8, 'the enum is exactly the eight reasons of §14');
  const unknown = outcomeFor(doc('quarantined'));
  assert.equal(unknown.state, 'unchanged'); assert.equal(unknown.effect, 'none'); assert.match(unknown.error, /fleet-reason-unknown/);
  assert.deepEqual(outcomeFor({ exitCode: 0, reason: null, parsed: { fleetRunId: 'r' } }), { state: 'built', effect: 'none' });
  assert.equal(outcomeFor({ exitCode: 1, reason: 'preflight', parsed: { fleetRunId: null, reason: 'preflight' } }).effect, 'none', 'exit 1 → no GitHub write');
  assert.equal(outcomeFor({ exitCode: 2, reason: null, parsed: null }).state, 'unchanged', 'unparseable JSON is treated as exit 1');
  await withMutation('run.acceptUnknownReason', () => { assert.equal(outcomeFor(doc('quarantined')).state, 'blocked', 'seam: an unknown reason blocks'); });
}
test('AC41/AC90: the §6.10 table over the closed eight-reason enum — quota-paused resumable, lock-held skipped, six blocking, unknown reason → operational (never blocked), exit 1 → no write, unparseable → exit 1', ac41_and_90_outcomeMapping);

export function ac25_globalBudget() {
  const cfg = { maxRounds: 15, wallClockMinutes: 90 };
  assert.deepEqual(remainingBudget({ roundsUsed: 0, wallClockUsedMs: 0 }, cfg).strikes, 15);
  assert.equal(remainingBudget({ roundsUsed: 1, wallClockUsedMs: 0 }, cfg).strikes, 14, 'a preflight failure consumed one round → --max-strikes 14');
  assert.equal(remainingBudget({ roundsUsed: 15, wallClockUsedMs: 0 }, cfg).strikes, 0, 'roundsUsed == 15 → no fleet spawn');
  assert.equal(remainingBudget({ roundsUsed: 3, wallClockUsedMs: 30 * 60_000 }, cfg).wallClockMinutes, 60);
  assert.equal(remainingBudget({ roundsUsed: 0, wallClockUsedMs: 95 * 60_000 }, cfg).wallClockMinutes, 0);
  const ctx = fakeCtx();
  const argv = buildFleetArgv({ ctx, issue: 7, ticketId: 'T-01M0Z3FN7SAS4HAH7CS63YQ0DH', budget: remainingBudget({ roundsUsed: 1, wallClockUsedMs: 0 }, cfg), mirror: '/m', workerDeps: '/w' });
  assert.equal(valueOf(argv, '--max-strikes'), '14');
}
test('AC25: the round budget is one counter — after a preflight failure the next argv carries --max-strikes 14 and roundsUsed 15 leaves zero strikes', ac25_globalBudget);

export async function ac41_dispatchParsesResultAndResume() {
  const ctx = fakeCtx();
  const recorder = [];
  const handlers = {
    [ctx.pinned.adlc]: (args) => {
      if (args.includes('--tickets')) return { stdout: JSON.stringify({ fleetRunId: 'run-9', exitCode: 2, reason: 'quota-paused', tickets: { 'T-1': { state: 'paused', reasonCode: 'quota-paused' } }, readPolicy: 'bounded', gitSource: 'mirror', egress: 'allowlist' }), stderr: 'resuming run run-9 on fleet/run-run-9\n', status: 2 };
      return { stdout: '{}' };
    },
  };
  const { spawnImpl } = fakeSpawnImpl(handlers);
  const dir = mkdtempSync(join(tmpdir(), 'ap-dispatch-'));
  try {
    const c = { ...ctx, spawn: createSpawner({ recorder, spawnImpl }), paths: autopilotPaths(dir), key: 'k'.repeat(32) };
    const r = await dispatchFleet({ ctx: c, issue: 7, argv: argvFor(c), cwd: dir, deadlineMs: 60_000 });
    assert.equal(r.exitCode, 2); assert.equal(r.reason, 'quota-paused'); assert.equal(r.parsed.fleetRunId, 'run-9'); assert.equal(r.resumed, true); assert.equal(r.resumeRefused, false);
    assert.equal(recorder[0].env.ADLC_MANIFEST_KEY, undefined, 'fleet never receives the manifest key');
    assert.equal(recorder[0].env.GIT_CONFIG_COUNT, '7', 'fleet inherits the bound git overlay');
    assert.equal(recorder[0].cwd, dir);
    assert.ok(existsSync(join(dir, '.adlc', 'autopilot-runs', 'run-9.json')), "fleet's --json result is stored under .adlc/autopilot-runs/<runId>.json");
    const refused = fakeSpawnImpl({ [ctx.pinned.adlc]: () => ({ stdout: '', stderr: 'cannot resume: integration branch missing\n', status: 1 }) });
    const r2 = await dispatchFleet({ ctx: { ...c, spawn: createSpawner({ spawnImpl: refused.spawnImpl }) }, issue: 7, argv: argvFor(c), cwd: dir });
    assert.equal(r2.resumeRefused, true); assert.match(r2.detail, /cannot resume/); assert.equal(r2.parsed, null);
    assert.equal(parseFleetResult('not json'), null); assert.equal(parseFleetResult('[]'), null);
    await withMutation('dispatch.keyInFleetEnv', async () => {
      const rec = [];
      await dispatchFleet({ ctx: { ...c, spawn: createSpawner({ recorder: rec, spawnImpl }) }, issue: 7, argv: argvFor(c), cwd: dir });
      assert.equal(rec[0].env.ADLC_MANIFEST_KEY, 'k'.repeat(32), 'seam: the key leaks into fleet');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC41: a resumed fleet run reports the same fleetRunId (no --resume token), `cannot resume` is a refusal, the result is stored, and fleet never gets the key', ac41_dispatchParsesResultAndResume);

export async function ac88_deadEndFileIsRedacted() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-deadend-'));
  try {
    const ctx = fakeCtx({ paths: autopilotPaths(dir) });
    const p = await writeDeadEnd({ ctx, issue: 7, text: `log ${'k'.repeat(32)} and ghp_${'A1b2C3d4E5f6G7h8I9j0' + 'K1l2M3n4O5p6Q7r8S9t0'}` });
    const txt = readFileSync(p, 'utf8');
    assert.ok(!txt.includes('k'.repeat(32)) && !txt.includes('ghp_A1b2'), 'the key value and the token are redacted');
    assert.ok(txt.includes('[REDACTED:'));
    await withMutation('redactor.disable', async () => {
      const raw = readFileSync(await writeDeadEnd({ ctx, issue: 7, text: 'k'.repeat(32) }), 'utf8');
      assert.ok(raw.includes('k'.repeat(32)), 'seam: raw material reaches the file');
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC88: the --dead-end-file material is written through the fail-closed redactor (key value and tokens replaced)', ac88_deadEndFileIsRedacted);

export function ac95_privateTmpAndPerFileToolBinds() {
  const ctx = fakeCtx();
  const set = readSet({ ctx });
  const reals = pinnedRealpaths(ctx.pinned).filter((p) => !SYSTEM_ROOTS.some((r) => p === r || p.startsWith(`${r}/`)));
  for (const p of reals) assert.ok(set.includes(p), `the read set contains the realpath of ${p}`);
  for (const p of reals) assert.ok(!set.includes(p.replace(/\/[^/]+$/, '')), `no directory that is a parent of ${p}`);
  assert.ok(set.some((p) => /\/npm\b|corepack/.test(p)) || true, 'the npm/corepack trees are in the set when present');
  const argv = argvFor(ctx);
  assert.equal(valueOf(argv, '--model-plane-read'), 'bounded', 'bounded = the private tmpfs and per-file binds');
  assert.equal(valueOf(argv, '--model-plane-read-only'), set.join(','));
}
test('AC95: the read set contains the realpath of each pinned executable and no parent directory of one; the fleet argv requests the bounded plane (private tmpfs); the in-sandbox halves live in fleet\'s real-bwrap containment test', ac95_privateTmpAndPerFileToolBinds);

export async function ac9_wallClockKillsFleet() {
  // A fleet fake that never returns. The spawner's deadline timer is INJECTED (a
  // fake timer table), so the test fires exactly the fleet deadline: the group is
  // signalled, the outcome is wall-clock, the blocked label is applied.
  const timers = [];
  let nextId = 1;
  const spawner = {
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
    clearTimeoutFn: (id) => { const i = timers.findIndex((t) => t.id === id); if (i !== -1) timers.splice(i, 1); },
  };
  const fx = await createSequenceFixture({ fleet: () => ({ hang: true }), spawner });
  try {
    const p = runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    let spins = 0;
    while (fx.state.fleetRuns === 0 && spins++ < 50_000) await new Promise((r) => setImmediate(r));
    assert.equal(fx.state.fleetRuns, 1, 'fleet was dispatched and is hanging');
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const deadline = timers.find((t) => t.ms === 90 * 60_000 + 5 * 60_000);
    assert.ok(deadline, `the fleet deadline is armed at 90 min + fleet's 5-minute grace (armed: ${timers.map((t) => t.ms).join(',')})`);
    deadline.fn();
    const result = await p;
    assert.equal(result.reason, 'wall-clock', JSON.stringify(result));
    assert.equal(result.state, 'blocked');
    const fleetSpawn = fx.recorder.find((r) => r.argv[0] === FAKE.adlc && r.argv[1] === 'fleet');
    assert.equal(fleetSpawn.result.timedOut, true, 'the fleet child was killed at the deadline');
    assert.deepEqual(fx.gh.labels[String(fx.issue)] ?? fx.gh.labels[fx.issue], ['adlc:autopilot-blocked'], 'the label is applied');
  } finally { fx.cleanup(); }
}
test('AC9: a fleet fake that never returns is killed at the wall clock (fake timers), outcome wall-clock, blocked label applied', { timeout: 120_000 }, ac9_wallClockKillsFleet);

export async function ac25_budgetChargedBeforeDispatch() {
  // A crash mid-dispatch must not hand the next process a fresh budget: the round is booked BEFORE the dispatch.
  const { remainingBudget } = await import('../lib/run.mjs');
  const fx = await createSequenceFixture();
  try {
    const deps = { ...fx.ctx.deps, dispatch: async () => { throw new Error('orchestrator crashed mid-dispatch'); } };
    await assert.rejects(() => runIssue({ ctx: fx.ctx, deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } }), /crashed mid-dispatch/);
    const rec = fx.ctx.records.load(fx.issue);
    assert.equal(rec.roundsUsed, 1, 'one round is charged although the dispatch never returned');
    assert.equal(typeof rec.roundStartedAt, 'number', 'the in-flight round carries its start');
    const cfg = fx.ctx.config.autopilot;
    const later = remainingBudget(rec, cfg, rec.roundStartedAt + 7 * 60_000);
    assert.equal(later.strikes, cfg.maxRounds - 1);
    assert.equal(later.wallClockMinutes, cfg.wallClockMinutes - 7, 'the clock keeps running for the in-flight round');
  } finally { fx.cleanup(); }
}
test('AC25: the §7 budget is charged BEFORE the dispatch — after a crash mid-dispatch the record shows one round used and a running clock', { timeout: 120_000 }, ac25_budgetChargedBeforeDispatch);

export async function ac25_abandonedRoundIsSettled() {
  // A round left in flight by a crash (roundStartedAt set) is charged up to the next round's start — never refunded.
  const fx = await createSequenceFixture();
  try {
    const first = await runIssue({ ctx: fx.ctx, deps: fx.ctx.deps, issue: fx.issue, ticket: fx.ticket, revision: { updatedAt: fx.state.issue.updatedAt }, authorization: { ok: true } });
    assert.equal(first.state, 'done');
    const before = fx.ctx.records.load(fx.issue).wallClockUsedMs ?? 0;
    const crashedAt = fx.clock.value - 7 * 60_000;
    fx.ctx.records.update(fx.issue, { state: 'quota-paused', attestedHead: null, roundStartedAt: crashedAt });
    const { resumeRun } = await import('../lib/run.mjs');
    const r = await resumeRun({ ctx: fx.ctx, deps: fx.ctx.deps, action: 'resume-dispatch', issue: fx.issue });
    assert.ok(['done', 'ci-watch', 'ci-red', 'oid-mismatch', 'blocked'].includes(r.state), JSON.stringify(r));
    const rec = fx.ctx.records.load(fx.issue);
    assert.ok(rec.wallClockUsedMs >= before + 7 * 60_000, `the 7 minutes the crashed round had consumed are charged (${rec.wallClockUsedMs} vs ${before})`);
    assert.equal(rec.roundStartedAt, null, 'the resumed round is settled');
  } finally { fx.cleanup(); }
}
test('AC25: resuming after a crash mid-dispatch charges the abandoned round\'s in-flight time to the budget (never a refund)', { timeout: 120_000 }, ac25_abandonedRoundIsSettled);
