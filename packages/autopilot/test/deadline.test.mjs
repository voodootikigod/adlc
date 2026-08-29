// AC 49 / AC 64 / AC 102 — the shared spawn wrapper: every child gets an argv
// array with shell:false, its own process group, a deadline that signals the
// GROUP (SIGTERM, SIGKILL 15 s later), a closed stdin unless the caller passes
// bytes, and a stdout cap that kills the child. Fake children, fake clock.

import { test, mock } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { createSpawner, DEADLINES, KILL_GRACE_MS, withRetry, RETRY_BACKOFF_MS } from '../lib/spawn.mjs';
import { fakeSpawnImpl } from './helpers/fake-children.mjs';

function harness(handlers) {
  const kills = [];
  const { spawnImpl, kill } = fakeSpawnImpl(handlers, { kills });
  const recorder = [];
  return { kills, recorder, spawn: createSpawner({ recorder, spawnImpl, kill }) };
}

export async function ac49_deadlineSignalsGroupThenKills() {
  const h = harness({ '/bin/stubborn': () => ({ ignoreSigterm: true, hang: true }) });
  const p = h.spawn({ argv: ['/bin/stubborn', 'x'], cwd: '/', env: {}, deadlineMs: 50, label: 'npm ci' });
  assert.equal(h.recorder[0].deadlineMs, 50, 'the deadline is ARMED (asserted before waiting, so an unarmed deadline fails instead of hanging)');
  const res = await p;
  assert.equal(res.timedOut, true);
  assert.equal(res.reason, 'timeout:npm ci', 'the step fails with timeout:<command>');
  assert.ok(h.kills.length >= 2, `SIGTERM then SIGKILL were sent: ${JSON.stringify(h.kills)}`);
  assert.deepEqual(h.kills.map((k) => k.signal), ['SIGTERM', 'SIGKILL']);
  assert.ok(h.kills.every((k) => k.pid < 0), 'signals target the process GROUP (negative pid)');
  assert.equal(h.recorder[0].deadlineMs, 50);
  assert.equal(KILL_GRACE_MS, 15_000);
}
test('AC49: the deadline wrapper SIGTERMs the process group, SIGKILLs after the grace, and fails timeout:<command>', { timeout: 60_000 }, ac49_deadlineSignalsGroupThenKills);
test('AC49: on expiry the wrapper SIGTERMs the process group, SIGKILLs after the grace, and fails timeout:<command>', { timeout: 60_000 }, async () => {
  // The grace period is 15 s of real time in production; drive it with mocked timers.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness({ '/bin/stubborn': () => ({ ignoreSigterm: true, hang: true }) });
    const p = h.spawn({ argv: ['/bin/stubborn'], cwd: '/', env: {}, deadlineMs: 1000, label: 'npm ci' });
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    mock.timers.tick(1000);
    assert.deepEqual(h.kills.map((k) => k.signal), ['SIGTERM'], 'SIGTERM at the deadline');
    mock.timers.tick(KILL_GRACE_MS);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.kills.map((k) => k.signal), ['SIGTERM', 'SIGKILL'], 'SIGKILL exactly 15 s later');
    const res = await p;
    assert.equal(res.reason, 'timeout:npm ci');
    assert.ok(h.kills.every((k) => k.pid < 0));
  } finally { mock.timers.reset(); }
});
test('AC49: (real timers) a SIGTERM-ignoring child is ended by SIGKILL to the group', { timeout: 30_000 }, async () => {
  // KILL_GRACE_MS is 15 s; this variant proves the real-timer path resolves — and that a leader which
  // dies on SIGTERM still gets the GROUP SIGKILL at once (a descendant may have survived it).
  const h = harness({ '/bin/stubborn': () => ({ ignoreSigterm: false, hang: true }) });
  const res = await h.spawn({ argv: ['/bin/stubborn'], cwd: '/', env: {}, deadlineMs: 20, label: 'x' });
  assert.equal(res.timedOut, true);
  assert.deepEqual(h.kills.map((k) => k.signal), ['SIGTERM', 'SIGKILL'], 'the group is SIGKILLed when the leader exits before the grace');
  assert.ok(h.kills.every((k) => k.pid < 0));
});

export function ac49_deadlineTableIsTheSpecTable() {
  assert.equal(DEADLINES.gitNetwork, 120_000);
  assert.equal(DEADLINES.git, 60_000);
  assert.equal(DEADLINES.gh, 60_000);
  assert.equal(DEADLINES.npmCi, 15 * 60_000);
  assert.equal(DEADLINES.preflightScript, 30 * 60_000);
  assert.equal(DEADLINES.fleetGraceMs, 5 * 60_000);
  assert.equal(DEADLINES.finalReview, 15 * 60_000);
  assert.equal(DEADLINES.adlcRecorder, 60_000);
  assert.equal(DEADLINES.quotaHttp, 10_000);
  assert.equal(DEADLINES.usageFallback, 60_000);
  assert.equal(DEADLINES.claude, 5 * 60_000);
  assert.equal(DEADLINES.ciPoll, 60_000);
  assert.deepEqual([...RETRY_BACKOFF_MS], [5_000, 15_000, 45_000]);
}
test('AC49: every §12.1 row has its deadline constant (120s/60s/15m/30m/+5m/15m/60s/10s/60s/5m/60s) and the 5/15/45 s backoff', ac49_deadlineTableIsTheSpecTable);

export async function ac49_retryOnlyRetryable() {
  const seen = [];
  const sleeps = [];
  const r = await withRetry(async (n) => { seen.push(n); return { status: n < 3 ? 1 : 0 }; }, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(r.status, 0); assert.deepEqual(seen, [1, 2, 3]); assert.deepEqual(sleeps, [5_000, 15_000]);
  const lease = await withRetry(async () => ({ status: 1, lease: true }), { retryable: () => false, sleep: async () => { throw new Error('must not sleep'); } });
  assert.equal(lease.status, 1, 'a lease failure is never retried');
}
test('AC49: retried network commands use the fixed backoff; a push lease failure is never retried', ac49_retryOnlyRetryable);

export async function ac64_argvArrayShellFalse() {
  const h = harness({ '/opt/adlc': (args) => ({ stdout: JSON.stringify(args) }) });
  const res = await h.spawn({ argv: ['/opt/adlc', '--model', 'opus;touch /tmp/x', '$(id)'], cwd: '/', env: { PATH: '/usr/bin' } });
  assert.deepEqual(JSON.parse(res.stdout), ['--model', 'opus;touch /tmp/x', '$(id)'], 'metacharacters reach the child as single argv elements');
  assert.equal(h.recorder[0].shell, false);
  assert.deepEqual(h.recorder[0].argv, ['/opt/adlc', '--model', 'opus;touch /tmp/x', '$(id)']);
  assert.throws(() => h.spawn({ argv: 'adlc --model opus', cwd: '/', env: {} }), /array/);
}
test('AC64: every child is spawned with an argv ARRAY and shell:false — a metacharacter element is one element', ac64_argvArrayShellFalse);

export async function ac102_promptOnStdinNeverArgv() {
  const h = harness({ '/opt/claude': (args, { stdin }) => ({ stdout: JSON.stringify({ args, stdin }) }) });
  const prompt = "'; touch /tmp/x; echo '$(id)";
  const res = await h.spawn({ argv: ['/opt/claude', '-p', '--output-format', 'json'], cwd: '/', env: {}, stdinBytes: prompt, deadlineMs: DEADLINES.claude });
  const seen = JSON.parse(res.stdout);
  assert.equal(seen.stdin, prompt, 'the prompt arrives on stdin byte for byte');
  assert.ok(!seen.args.includes(prompt), 'and never as an argv element');
  assert.equal(h.recorder[0].stdinBytes.toString(), prompt, 'the recorder captured the stdin payload');
  // A spawn WITHOUT stdinBytes has stdin closed: the child reads nothing.
  const closed = await h.spawn({ argv: ['/opt/claude'], cwd: '/', env: {} });
  assert.equal(JSON.parse(closed.stdout).stdin, '');
  assert.equal(h.recorder[1].stdinBytes, null);
}
test('AC102: a claude prompt is delivered as stdinBytes, never in argv; every other spawn has stdin closed', ac102_promptOnStdinNeverArgv);

export async function ac49_stdoutCapKillsChild() {
  const h = harness({ '/bin/loud': () => ({ stdout: 'x'.repeat(5000), hang: false, status: 0 }) });
  const res = await h.spawn({ argv: ['/bin/loud'], cwd: '/', env: {}, stdoutCap: 1000, label: 'gh run view' });
  assert.equal(res.truncated, true);
  assert.equal(res.reason, 'stdout-cap:gh run view');
  assert.ok(h.kills.some((k) => k.signal === 'SIGTERM' && k.pid < 0), 'the child group is signalled on overflow');
}
test('AC49: exceeding the stdout cap kills the child and marks the capture truncated', ac49_stdoutCapKillsChild);

export async function ac49_envIsExactlyWhatWasPassed() {
  const h = harness({ '/bin/env': (args, { env }) => ({ stdout: JSON.stringify(env) }) });
  process.env.ADLC_AUTOPILOT_TEST_LEAK = 'leak';
  try {
    const res = await h.spawn({ argv: ['/bin/env'], cwd: '/', env: { PATH: '/usr/bin' } });
    assert.deepEqual(JSON.parse(res.stdout), { PATH: '/usr/bin' }, 'nothing from process.env is inherited');
  } finally { delete process.env.ADLC_AUTOPILOT_TEST_LEAK; }
}
test('AC49: a child receives exactly the env the caller built — never process.env', ac49_envIsExactlyWhatWasPassed);

export async function ac49_descendantsDieWithTheGroup() {
  // The leader dies on SIGTERM; a grandchild that ignores TERM must not outlive the deadline — the whole GROUP is SIGKILLed.
  const { createSpawner } = await import('../lib/spawn.mjs');
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'ap-group-kill-'));
  const pidfile = join(dir, 'grandchild.pid');
  try {
    const spawn = createSpawner({ recorder: [] });
    // The grandchild is its OWN process (an exec'd sh whose $$ is itself), ignoring TERM; the leader is a plain sleep.
    // The grandchild closes its stdio (a real daemon does), so the leader's close fires as soon as the leader dies.
    const script = `(trap '' TERM; exec sh -c 'trap "" TERM; echo $$ > ${pidfile}; exec sleep 60' >/dev/null 2>&1 </dev/null) & exec sleep 60`;
    const res = await spawn({ argv: ['/bin/sh', '-c', script], cwd: dir, env: { PATH: process.env.PATH }, deadlineMs: 500, label: 'tree' });
    assert.equal(res.timedOut, true);
    assert.ok(existsSync(pidfile), 'the grandchild recorded its pid');
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; } }
    if (alive) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    assert.equal(alive, false, 'the TERM-ignoring grandchild was killed with the group (the leader exiting first did not cancel it)');
    // A leader that exits NORMALLY (status 0) after forking a survivor takes it with it too (fleet codex r23 #1).
    rmSync(pidfile, { force: true });
    const normal = `(trap '' TERM; exec sh -c 'trap "" TERM; echo $$ > ${pidfile}; exec sleep 60' >/dev/null 2>&1 </dev/null) & sleep 0.2; exit 0`;
    const res2 = await spawn({ argv: ['/bin/sh', '-c', normal], cwd: dir, env: { PATH: process.env.PATH }, deadlineMs: 10_000, label: 'tree' });
    assert.equal(res2.status, 0); assert.equal(res2.timedOut, false);
    const pid2 = Number(readFileSync(pidfile, 'utf8').trim());
    let alive2 = true;
    for (let i = 0; i < 40 && alive2; i++) { try { process.kill(pid2, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive2 = false; } }
    if (alive2) { try { process.kill(pid2, 'SIGKILL'); } catch { /* gone */ } }
    assert.equal(alive2, false, 'a survivor of a NORMAL exit is gone once the call resolved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('AC49: (real processes) a grandchild that ignores SIGTERM dies with the process group at the deadline even though the leader exits first', { timeout: 30_000 }, ac49_descendantsDieWithTheGroup);
