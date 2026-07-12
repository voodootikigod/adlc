import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight, checkCleanTree, resolveSandboxForRun } from '../lib/preflight.mjs';
import { LOCK_DIR } from '../lib/lock.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fleet-preflight-'));
const HOST = 'host-a';
const self = { pid: 4242, host: HOST, runId: 'r', startedAt: 't', procStartTime: 'p' };
const deadProbes = { host: HOST, pidAlive: () => false, procStartTimeOf: () => null };
const cleanGit = () => (...a) => (a[0] === 'status' ? '' : '');
const io = (over = {}) => ({ git: () => cleanGit(), adlc: () => ({ status: 0, stdout: '{"pairs":[]}' }), ...over });
const bwrapHost = { platform: 'linux', hasCmd: (c) => c === 'bwrap' };

const base = (over = {}) => ({
  repo: '/repo', config: { operatorOverride: false, gate: { test: 'npm test' } }, statusDir: tmp(), io: io(),
  self, probes: deadProbes, railHookInstalled: () => true, ...bwrapHost, ...over,
});

test('preflight fails closed when no gate is configured (AC / M1)', () => {
  const r = runPreflight(base({ config: { operatorOverride: false } })); // no gate
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.reason, /gate/i);
});

test('resolveSandboxForRun requires a real backend (fails closed on unshare-only)', () => {
  assert.equal(resolveSandboxForRun({}, { platform: 'linux', hasCmd: (c) => c === 'unshare' }).refused, true);
  assert.equal(resolveSandboxForRun({}, { platform: 'linux', hasCmd: (c) => c === 'bwrap' }).mode, 'sandbox');
});

test('checkCleanTree refuses a dirty checkout', () => {
  assert.equal(checkCleanTree(() => ' M file.js').ok, false);
  assert.equal(checkCleanTree(() => '').ok, true);
});

test('preflight fails closed with NO sandbox and no override (AC2)', () => {
  const r = runPreflight(base({ platform: 'linux', hasCmd: () => false }));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.reason, /sandbox/i);
});

test('preflight refuses a dirty main checkout (AC2 ii)', () => {
  const dirtyIo = io({ git: () => (...a) => (a[0] === 'status' ? ' M x.js' : '') });
  const r = runPreflight(base({ io: dirtyIo }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /dirty|uncommitted/i);
});

test('preflight aborts when the canary fails — BEFORE any real dispatch (AC2 i)', () => {
  const sd = tmp();
  const r = runPreflight(base({ statusDir: sd, dispatchCanary: () => ({ ok: false, output: 'permission denied' }) }));
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.reason, /canary/i);
  assert.equal(existsSync(join(sd, LOCK_DIR)), false, 'the lock is released on a preflight abort');
});

test('preflight warns loudly (not silently) when the rail hook is absent (AC2 iv)', () => {
  const r = runPreflight(base({ railHookInstalled: () => false }));
  assert.equal(r.ok, true, 'absent hook does not block the run (advisory-in-depth)');
  assert.ok(r.warnings.some((w) => /rail hook/i.test(w)), 'but it MUST warn');
});

test('preflight refuses when another live instance holds the lock (AC2 iii)', () => {
  const sd = tmp();
  // First run acquires and holds the lock; its pid is "alive".
  const liveProbes = { host: HOST, pidAlive: (p) => p === 4242, procStartTimeOf: (p) => (p === 4242 ? 'p' : null) };
  const first = runPreflight(base({ statusDir: sd, probes: deadProbes }));
  assert.equal(first.ok, true);
  // Second run sees the live lock → refuses.
  const second = runPreflight(base({ statusDir: sd, self: { ...self, pid: 5000, procStartTime: 'q' }, probes: liveProbes }));
  assert.equal(second.ok, false);
  assert.match(second.reason, /holds the lock/i);
});

test('preflight records the merge-forecast into the result (AC2 v)', () => {
  const r = runPreflight(base({ io: io({ adlc: () => ({ status: 0, stdout: '{"pairs":[{"pair":"T1-T2","verdict":"PARALLEL"}]}' }) }) }));
  assert.equal(r.ok, true);
  assert.ok(r.forecast, 'forecast captured');
  assert.equal(r.forecast.pairs.length, 1);
});

test('a happy preflight returns the resolved sandbox spec and holds the lock', () => {
  const sd = tmp();
  const r = runPreflight(base({ statusDir: sd }));
  assert.equal(r.ok, true);
  assert.equal(r.sandboxSpec.mode, 'sandbox');
  assert.equal(r.lockHeld, true);
  assert.equal(existsSync(join(sd, LOCK_DIR)), true, 'lock held for the run');
});
