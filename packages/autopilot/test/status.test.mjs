// AC 87 — the reservation ordinal is a fact of record: `startsThisIteration`
// lives in the status file, is 0 at the top of an iteration, is incremented
// atomically by every start (the loop's own steps and the pre-strike helper
// alike) under the autopilot lock, and the reserve applies from ordinal 2.
// The quota-gate reconciliation appends to the status file AND the run record.

import { test } from './helpers/node-test.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createStatusStore } from '../lib/status.mjs';
import { createQuotaGate } from '../lib/quota-gate.mjs';
import { autopilotPaths } from '../lib/paths.mjs';
import { acquireLock } from '../lib/lock.mjs';
import { createRedactor } from '../lib/redact.mjs';
import { createRecordStore } from '../lib/records.mjs';
import { withMutation } from '../lib/mutations.mjs';
import { scratch, cleanup, prOpenRecord } from './helpers/review-ctx.mjs';

const probes = { pidAlive: () => true, pidStartTimeOf: () => '1' };
const usage = (fiveHour) => ({ ok: true, fiveHour, sevenDay: 10, resetsAt: { fiveHour: '2026-08-28T20:00:00Z', sevenDay: null }, scoped: new Map() });

export async function ac87_ordinalIsRecordedUnderTheLock() {
  const root = scratch('ap-status');
  try {
    const paths = autopilotPaths(root); mkdirSync(paths.adlc, { recursive: true });
    const redactor = createRedactor({});
    const lock = acquireLock(paths.adlc, { self: { pid: process.pid, pidStartTime: '1' }, probes });
    const store = createStatusStore({ paths, lockToken: lock.token, redactor });
    assert.equal(store.resetStarts('it-1'), 0);
    assert.equal(store.read().startsThisIteration, 0, '0 at the top of an iteration');
    assert.equal(store.incrementStarts(), 1, '1 after shaping');
    // Two pre-strike helper invocations: separate store instances (separate processes) over the same file + lock.
    const helper1 = createStatusStore({ paths, lockToken: lock.token, redactor });
    const helper2 = createStatusStore({ paths, lockToken: lock.token, redactor });
    assert.equal(helper1.incrementStarts(), 2);
    assert.equal(helper2.incrementStarts(), 3);
    assert.equal(store.read().startsThisIteration, 3, 'every increment is persisted in the file');
    // The reserve applies from ordinal 2 through the gate bound to this store.
    const gate = createQuotaGate({ read: async () => usage(46), status: store, records: createRecordStore({ paths, redactor }), model: 'opus', threshold: 50, reserve: 5 });
    const first = await gate.sample({ ordinal: 1 });
    assert.equal(first.ok, true, '46% admits the FIRST start (threshold 50)'); assert.equal(first.threshold, 50);
    const second = await gate.sample({ ordinal: 2 });
    assert.equal(second.ok, false, '46% refuses a later start (50 − 5)'); assert.equal(second.threshold, 45); assert.equal(second.reason, 'five_hour');
    assert.equal(store.read().quota.fiveHour, 46, 'the sample is published in the status file');
    // A helper without the lock exits 1.
    const stranger = createStatusStore({ paths, lockToken: 'e'.repeat(64), redactor });
    assert.throws(() => stranger.incrementStarts(), (e) => e.code === 'lock-required' && e.exitCode === 1, 'a foreign token is refused');
    assert.throws(() => createStatusStore({ paths, lockToken: null, redactor }).incrementStarts(), (e) => e.code === 'lock-required', 'no token is refused');
    assert.equal(store.read().startsThisIteration, 3, 'a refused increment writes nothing');
    assert.equal(lock.release(), true);
    assert.throws(() => store.incrementStarts(), (e) => e.code === 'lock-required', 'a released lock refuses the holder too');
    await withMutation('status.noLockForOrdinal', () => {
      assert.equal(stranger.incrementStarts(), 4, 'seam: the ordinal increments without the lock (what the coverage gate injects)');
    });
  } finally { cleanup(root); }
}
test('AC87: startsThisIteration is 0 at the top, 1 after shaping, each pre-strike helper increment persists and applies the reserve from ordinal 2, and a helper without the lock exits 1', ac87_ordinalIsRecordedUnderTheLock);

export async function ac87_reconciliationAppendsToStatusAndRecord() {
  const root = scratch('ap-status');
  try {
    const paths = autopilotPaths(root); mkdirSync(paths.adlc, { recursive: true });
    const redactor = createRedactor({});
    const records = createRecordStore({ paths, redactor });
    records.save(prOpenRecord({ issue: 7 }));
    let reading = 40;
    const status = createStatusStore({ paths, lockToken: null, redactor });
    const gate = createQuotaGate({ read: async () => usage(reading), status, records, model: 'opus', threshold: 50, reserve: 5 });
    const before = await gate.sample({ ordinal: 1 });
    reading = 52;
    const entry = await gate.reconcile('shaping', before, { issue: 7 });
    assert.equal(entry.step, 'shaping'); assert.equal(entry.delta, 12); assert.equal(entry.overshoot, true);
    const doc = status.read();
    assert.equal(doc.quotaSteps.length, 1); assert.equal(doc.quotaSteps[0].step, 'shaping'); assert.equal(doc.quotaSteps[0].overshoot, true);
    assert.equal(doc.quota.fiveHour, 52, 'quota.after is published');
    const rec = records.load(7);
    assert.equal(rec.quotaSteps.length, 1); assert.equal(rec.quotaSteps[0].after.fiveHour, 52, 'the run record carries the same entry');
    assert.equal((await gate.sample({ ordinal: 1 })).ok, false, 'the next start is refused by the ordinary gate');
    await withMutation('quota-gate.skipRecordAppend', async () => {
      await gate.reconcile('coldstart', before, { issue: 7 });
      assert.equal(records.load(7).quotaSteps.length, 1, 'seam: the record is not appended');
    });
    assert.equal(status.read().quotaSteps.length, 2);
  } finally { cleanup(root); }
}
test('AC87: reconcile appends {step, before, after, delta, overshoot} to the status file and the run record, and an overshoot refuses the next start', ac87_reconciliationAppendsToStatusAndRecord);

export async function ac87_ordinalIsBumpedFromSeparateProcesses() {
  // N REAL processes bump the ordinal concurrently over the same file + lock: the ordinals are exactly 1..N, each once.
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = scratch('ap-status-procs');
  try {
    const paths = autopilotPaths(root); mkdirSync(paths.runsDir, { recursive: true });
    const probes = { pidAlive: () => true, pidStartTimeOf: () => '1' };
    const lock = acquireLock(paths.adlc, { self: { pid: process.pid, pidStartTime: '1' }, probes });
    const store = createStatusStore({ paths, lockToken: lock.token, redactor: createRedactor({}) });
    store.resetStarts('it-p');
    const statusMod = fileURLToPath(new URL('../lib/status.mjs', import.meta.url));
    const pathsMod = fileURLToPath(new URL('../lib/paths.mjs', import.meta.url));
    const redactMod = fileURLToPath(new URL('../lib/redact.mjs', import.meta.url));
    const mutationsMod = fileURLToPath(new URL('../lib/mutations.mjs', import.meta.url));
    const { activeSeams } = await import('../lib/mutations.mjs');
    const script = `const { createStatusStore } = await import(${JSON.stringify(statusMod)}); const { autopilotPaths } = await import(${JSON.stringify(pathsMod)}); const { createRedactor } = await import(${JSON.stringify(redactMod)});
      const { enable } = await import(${JSON.stringify(mutationsMod)}); for (const seam of ${JSON.stringify(activeSeams())}) enable(seam);
      const s = createStatusStore({ paths: autopilotPaths(${JSON.stringify(root)}), lockToken: ${JSON.stringify(lock.token)}, redactor: createRedactor({}) }); process.stdout.write(String(s.incrementStarts()));`;
    const N = 6;
    const outs = await Promise.all(Array.from({ length: N }, () => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`helper exited ${code}: ${err.slice(0, 300)}`))));
    })));
    assert.deepEqual(outs.map(Number).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i + 1), `six concurrent processes got six distinct ordinals: ${outs.join(',')}`);
    assert.equal(store.read().startsThisIteration, N, 'the file holds the last ordinal');
    // A process whose token is not the on-disk owner's is refused (the lock is load-bearing for the ordinal).
    const badScript = script.replace(JSON.stringify(lock.token), JSON.stringify('f'.repeat(64)));
    const bad = await new Promise((resolve) => { const c = spawn(process.execPath, ['--input-type=module', '-e', badScript], { stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => resolve({ code, err })); });
    assert.notEqual(bad.code, 0, 'a wrong token is refused'); assert.match(bad.err, /lock-required/);
    assert.equal(store.read().startsThisIteration, N, 'the refused process did not bump the ordinal');
  } finally { cleanup(root); }
}
test('AC87: the start ordinal is bumped by concurrent REAL processes over the same file and lock — every process gets a distinct ordinal (1..N) and the file holds N', { timeout: 60_000 }, ac87_ordinalIsBumpedFromSeparateProcesses);

export async function ac87_orchestratorWritesNeverClobberHelperOrdinals() {
  // The orchestrator's own writes (pinTools, recordQuota, write) interleave with helper increments: no ordinal is lost.
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = scratch('ap-status-clobber');
  try {
    const paths = autopilotPaths(root); mkdirSync(paths.runsDir, { recursive: true });
    const probes = { pidAlive: () => true, pidStartTimeOf: () => '1' };
    const lock = acquireLock(paths.adlc, { self: { pid: process.pid, pidStartTime: '1' }, probes });
    const store = createStatusStore({ paths, lockToken: lock.token, redactor: createRedactor({}) });
    store.resetStarts('it-c');
    const mods = ['status', 'paths', 'redact', 'mutations'].map((m) => fileURLToPath(new URL(`../lib/${m}.mjs`, import.meta.url)));
    const { activeSeams } = await import('../lib/mutations.mjs');
    const script = `const { createStatusStore } = await import(${JSON.stringify(mods[0])}); const { autopilotPaths } = await import(${JSON.stringify(mods[1])}); const { createRedactor } = await import(${JSON.stringify(mods[2])});
      const { enable } = await import(${JSON.stringify(mods[3])}); for (const seam of ${JSON.stringify(activeSeams())}) enable(seam);
      const s = createStatusStore({ paths: autopilotPaths(${JSON.stringify(root)}), lockToken: ${JSON.stringify(lock.token)}, redactor: createRedactor({}) });
      let last = 0; for (let i = 0; i < 20; i++) last = s.incrementStarts(); process.stdout.write(String(last));`;
    const child = new Promise((resolve, reject) => { const c = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(err.slice(0, 300))))); });
    // Meanwhile the orchestrator writes other fields 200 times.
    for (let i = 0; i < 200; i++) { store.write({ lastError: `tick ${i}` }); await new Promise((r) => setImmediate(r)); }
    const last = await child;
    assert.equal(last, 20, 'the helper counted 20 increments');
    assert.equal(store.read().startsThisIteration, 20, 'none of the 20 increments was lost to an orchestrator write');
    assert.equal(store.read().lastError, 'tick 199', 'and the orchestrator\'s last write is there too');
    // Deterministic clause: while THIS process holds the file mutex, another process's write BLOCKS until it is released.
    const { mkdirSync: mk, rmSync: rm } = await import('node:fs');
    const mutexDir = `${paths.statusFile}.mutex`; mk(mutexDir);
    const writer = `const { createStatusStore } = await import(${JSON.stringify(mods[0])}); const { autopilotPaths } = await import(${JSON.stringify(mods[1])}); const { createRedactor } = await import(${JSON.stringify(mods[2])});
      const { enable } = await import(${JSON.stringify(mods[3])}); for (const seam of ${JSON.stringify(activeSeams())}) enable(seam);
      const t0 = Date.now(); const s = createStatusStore({ paths: autopilotPaths(${JSON.stringify(root)}), lockToken: ${JSON.stringify(lock.token)}, redactor: createRedactor({}) }); s.write({ lastError: 'from child' }); process.stdout.write(String(Date.now() - t0));`;
    const elapsedP = new Promise((resolve, reject) => { const c = spawn(process.execPath, ['--input-type=module', '-e', writer], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; }); c.on('exit', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(err.slice(0, 300))))); });
    await new Promise((r) => setTimeout(r, 700)); rm(mutexDir, { recursive: true, force: true });
    const elapsed = await elapsedP;
    assert.ok(elapsed >= 500, `the child's write waited for the held mutex (${elapsed} ms)`);
    assert.equal(store.read().lastError, 'from child');
  } finally { cleanup(root); }
}
test('AC87: the orchestrator\'s status writes and a helper process\'s ordinal increments interleave without losing an update (every persist is under the file mutex)', { timeout: 60_000 }, ac87_orchestratorWritesNeverClobberHelperOrdinals);

export async function ac87_recordQuotaUnderTheMutex() {
  // A second PROCESS holds the mutex, bumps the file, releases: recordQuota must wait and re-read, never
  // persist a snapshot taken before the mutex (agy r4 c8).
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawn } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'ap-status-mutex-'));
  try {
    const paths = autopilotPaths(root);
    mkdirSync(paths.runsDir ?? join(root, '.adlc', 'autopilot-runs'), { recursive: true });
    const store = createStatusStore({ paths, lockToken: () => null });
    store.write({});
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'); const file = process.argv[1]; const dir = file + '.mutex';
      fs.mkdirSync(dir);
      setTimeout(() => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); d.holderMark = 1; fs.writeFileSync(file, JSON.stringify(d)); fs.rmdirSync(dir); }, 250);
    `, paths.statusFile], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(existsSync(`${paths.statusFile}.mutex`), 'the other process holds the mutex');
    store.recordQuota('sample', null, { five: 1 });
    await new Promise((resolve) => holder.once('exit', resolve));
    assert.equal(store.read().holderMark, 1, 'the bump that landed while the mutex was held survives the quota record');
    assert.equal(store.read().quotaSteps.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('AC87: recordQuota is one read-modify-write under the cross-process mutex — a bump landing while another process holds it is never clobbered', { timeout: 20_000 }, ac87_recordQuotaUnderTheMutex);
