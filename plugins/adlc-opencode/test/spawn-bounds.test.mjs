// spawn-bounds.test.mjs — the OpenCode plugin runs in-process inside the host,
// so a synchronous `git` or `adlc` child that never exits freezes the host with
// nothing outside to reap it. Every spawn the session hooks, the file.edited
// watcher and the keyless bridge issue must carry a timeout with SIGKILL, and a
// child that ended without an exit code must never read as success.
//
// The real-blocking tests use a shim that `exec sleep`s, handed the exact
// options the production code passes, and each declares its own timeout so a
// regression fails instead of wedging the runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { checkPreflight, auditGateManifest, auditAdversarialReview } from '../lib/session-hooks.mjs';
import { handleFileEdited, createWatcherState } from '../lib/watcher.mjs';
import { runGateKeyless } from '../lib/keyless-bridge.mjs';

const BUDGET_MS = 5000;
const BOUND_MS = 2 * BUDGET_MS;

function initAdlc(t, { manifest = false } = {}) {
  const root = tmp(t, 'oc-bounds-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), '{"tickets":[]}');
  if (manifest) writeFileSync(join(root, '.adlc', 'manifest.jsonl'), '');
  return root;
}

function recorder(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const fn = (bin, args, opts) => { calls.push({ bin, args, opts }); return typeof result === 'function' ? result(bin, args) : result; };
  fn.calls = calls;
  return fn;
}

function assertBounded(calls) {
  assert.ok(calls.length > 0, 'the code under test spawned something');
  for (const { bin, args, opts } of calls) {
    const what = `${bin} ${args.join(' ')}`;
    assert.ok(Number.isInteger(opts?.timeout) && opts.timeout > 0, `${what} has a positive timeout`);
    assert.ok(opts.timeout <= BUDGET_MS, `${what} is bounded by the ${BUDGET_MS}ms budget`);
    assert.equal(opts.killSignal, 'SIGKILL', `${what} is killed with SIGKILL`);
  }
}

function blockingBin(t) {
  const dir = tmp(t, 'oc-blockbin-');
  const bin = join(dir, 'block');
  writeFileSync(bin, '#!/bin/sh\nexec sleep 100000\n');
  chmodSync(bin, 0o755);
  return bin;
}

// ── every spawn is bounded ───────────────────────────────────────────────

test('checkPreflight: adlc and git spawns are bounded', (t) => {
  const spawnImpl = recorder();
  checkPreflight(initAdlc(t), { spawnImpl, env: {} });
  assertBounded(spawnImpl.calls);
});

test('auditGateManifest: the verifier spawn is bounded', (t) => {
  const spawnImpl = recorder();
  auditGateManifest(initAdlc(t, { manifest: true }), { spawnImpl });
  assertBounded(spawnImpl.calls);
});

test('auditAdversarialReview: every git and adlc spawn is bounded', (t) => {
  const spawnImpl = recorder((bin, args) => {
    if (bin === 'git' && args[0] === 'status') return { status: 0, stdout: '?? secrets/k.pem\n' };
    if (bin === 'git' && args[0] === 'merge-base') return { status: 0, stdout: 'abc\n' };
    return { status: 0, stdout: '' };
  });
  auditAdversarialReview(initAdlc(t, { manifest: true }), { spawnImpl, env: {} });
  assertBounded(spawnImpl.calls);
  assert.ok(spawnImpl.calls.some((c) => c.bin === 'adlc'), 'the manifest lookup ran too');
});

test('keyless bridge: the --prompt-only spawn is bounded by the gate budget and SIGKILL', async () => {
  const spawnImpl = recorder({ status: 0, stdout: 'one prompt' });
  await runGateKeyless({ bin: 'adlc', args: ['spec-lint'], ask: async () => 'answer', spawnImpl });
  const { opts } = spawnImpl.calls[0];
  assert.ok(Number.isInteger(opts.timeout) && opts.timeout > 0);
  assert.equal(opts.killSignal, 'SIGKILL');
});

test('keyless bridge: a signal-killed --prompt-only run is an error, not an empty prompt set', async () => {
  const spawnImpl = recorder({ status: null, signal: 'SIGKILL', stdout: '' });
  await assert.rejects(
    () => runGateKeyless({ bin: 'adlc', args: ['spec-lint'], ask: async () => 'x', spawnImpl }),
    /SIGKILL|did not complete|exited/,
  );
});

// ── a child with no exit code is never success ───────────────────────────

test('auditGateManifest: a signal-killed verifier is NOT ok — the chain was not verified', (t) => {
  const r = auditGateManifest(initAdlc(t, { manifest: true }), {
    spawnImpl: () => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.warning, /did not finish/);
});

test('auditGateManifest: a timed-out verifier is NOT ok', (t) => {
  const err = Object.assign(new Error('spawnSync adlc ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const r = auditGateManifest(initAdlc(t, { manifest: true }), {
    spawnImpl: () => ({ status: null, signal: 'SIGKILL', error: err, stdout: '' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.warning, /did not finish/);
});

test('auditGateManifest: a missing adlc stays a silent skip (advisory by design)', (t) => {
  const err = Object.assign(new Error('spawnSync adlc ENOENT'), { code: 'ENOENT' });
  const r = auditGateManifest(initAdlc(t, { manifest: true }), { spawnImpl: () => ({ status: null, error: err }) });
  assert.deepEqual(r, { ok: true, skipped: true, warning: null });
});

test('auditGateManifest: a blocking verifier returns within the bound (real spawnSync)', { timeout: 30_000 }, (t) => {
  const bin = blockingBin(t);
  const start = Date.now();
  const r = auditGateManifest(initAdlc(t, { manifest: true }), { spawnImpl: (_b, _a, opts) => spawnSync(bin, [], opts) });
  assert.ok(Date.now() - start < BOUND_MS, `returned in ${Date.now() - start}ms`);
  assert.equal(r.ok, false);
});

test('auditAdversarialReview: a blocking git costs ONE budget for the whole scan (real spawnSync)', { timeout: 60_000 }, (t) => {
  const bin = blockingBin(t);
  const spawnImpl = (b, args, opts) => (b === 'git' ? spawnSync(bin, [], opts) : { status: 1, stdout: '' });
  const start = Date.now();
  const r = auditAdversarialReview(initAdlc(t), { spawnImpl, env: {} });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < BOUND_MS, `a scan of up to eleven git calls finished in ${elapsed}ms`);
  assert.equal(r.needed, false, 'no path could be read, so nothing is flagged');
});

// ── the watcher ──────────────────────────────────────────────────────────

function railRepo(t) {
  const dir = tmp(t, 'oc-bounds-watch-');
  mkdirSync(join(dir, '.adlc'), { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [{ id: 'T1', title: 'T1', rails: ['test/**'], scope: ['src/**'] }] }));
  writeFileSync(join(dir, 'test', 'x.mjs'), 'frozen\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return dir;
}

const ON = { ADLC_P4_ENFORCEMENT: '1', ADLC_TICKET: 'T1' };

test('watcher: the restore spawn is bounded', (t) => {
  const dir = railRepo(t);
  writeFileSync(join(dir, 'test', 'x.mjs'), 'OVERWRITTEN\n');
  const exec = recorder();
  handleFileEdited({ file: join(dir, 'test', 'x.mjs'), root: dir, env: ON, exec, state: createWatcherState() });
  assertBounded(exec.calls);
});

test('watcher: a signal-killed git checkout is not reported as a restore', (t) => {
  const dir = railRepo(t);
  writeFileSync(join(dir, 'test', 'x.mjs'), 'OVERWRITTEN\n');
  const exec = recorder({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' });
  const { actions } = handleFileEdited({ file: join(dir, 'test', 'x.mjs'), root: dir, env: ON, exec, state: createWatcherState() });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action, 'warned', 'a killed checkout restored nothing');
  assert.match(actions[0].message, /could NOT restore/);
});
