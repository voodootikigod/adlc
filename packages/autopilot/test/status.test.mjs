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
