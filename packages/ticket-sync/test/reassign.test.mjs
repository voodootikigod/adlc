import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sha256 } from '@adlc/core';
import { reassignId, planManifestMigration, migrateManifestEvidence } from '../lib/reassign.mjs';

// ---- reassignId (pure, store-wide edge rewrite) ----

test('reassignId renames the ticket and rewrites every edge that pointed at it', () => {
  const tickets = [
    { id: 'T7', title: 'created', scope: ['a/**'] },
    { id: 'T8', title: 'dependent', edges: [{ to: 'T7' }, { to: 'T9' }] },
    { id: 'gh:acme/app#1', title: 'remote', edges: [{ to: 'T7', contract: 'c.json' }] },
  ];
  const out = reassignId(tickets, 'T7', 'gh:acme/app#7');
  assert.equal(out[0].id, 'gh:acme/app#7');
  assert.deepEqual(out[1].edges.map((e) => e.to), ['gh:acme/app#7', 'T9'], 'edge to T7 rewritten; T9 untouched');
  assert.equal(out[2].edges[0].to, 'gh:acme/app#7');
  assert.equal(out[2].edges[0].contract, 'c.json', 'edge metadata preserved');
});

test('reassignId is immutable (no input mutation) and leaves untouched tickets identity-equal', () => {
  const untouched = { id: 'T1', title: 'x', edges: [{ to: 'T2' }] };
  const tickets = [{ id: 'T7', title: 'c' }, untouched];
  const out = reassignId(tickets, 'T7', 'gh:r#7');
  assert.equal(tickets[0].id, 'T7', 'input not mutated');
  assert.equal(out[1], untouched, 'a ticket with no match is returned by reference (no needless copy)');
});

test('reassignId no-ops when the id is absent', () => {
  const tickets = [{ id: 'T1', title: 'x' }];
  assert.deepEqual(reassignId(tickets, 'T99', 'gh:r#99'), tickets);
});

// ---- planManifestMigration (pure) ----

const ev = (ticket, gate, seq, data) => ({ ticket, gate, seq, ts: '2026-01-01T00:00:00Z', data, files: {} });

test('planManifestMigration selects the latest entry per gate bound to the old id', () => {
  const entries = [
    ev('T7', 'prosecution', 1, { verdict: 'blocked' }),
    ev('T7', 'prosecution', 5, { verdict: 'clear' }),
    ev('T7', 'p0', 2),
    ev('T8', 'prosecution', 9, { verdict: 'clear' }), // other ticket — excluded
  ];
  const plan = planManifestMigration(entries, 'T7');
  const byGate = Object.fromEntries(plan.map((e) => [e.gate, e]));
  assert.equal(Object.keys(byGate).length, 2);
  assert.equal(byGate.prosecution.seq, 5, 'latest prosecution wins (clear, not the earlier blocked)');
  assert.equal(byGate.prosecution.data.verdict, 'clear');
  assert.ok(byGate.p0);
});

test('planManifestMigration returns nothing when the old id has no evidence', () => {
  assert.deepEqual(planManifestMigration([ev('T8', 'prosecution', 1)], 'T7'), []);
});

test('planManifestMigration picks the highest seq even when entries are out of array order', () => {
  // seq — not array position — must drive "latest wins", so a superseded verdict is
  // never resurrected by recording order.
  const entries = [
    ev('T7', 'prosecution', 5, { verdict: 'clear' }),
    ev('T7', 'prosecution', 1, { verdict: 'blocked' }),
  ];
  const plan = planManifestMigration(entries, 'T7');
  assert.equal(plan.length, 1);
  assert.equal(plan[0].seq, 5);
  assert.equal(plan[0].data.verdict, 'clear', 'seq drives selection, not array order');
});

// ---- migrateManifestEvidence (append-only, chain-safe) ----

function fakeLedger(initial = []) {
  const lines = initial.map((e) => JSON.stringify(e));
  return {
    appended: [],
    read: () => ({ entries: lines.map((l) => JSON.parse(l)), skipped: [] }),
    append: (_name, entry) => { lines.push(JSON.stringify(entry)); fakeLedger._last = entry; },
    readRaw: () => (lines.length ? lines[lines.length - 1] : null),
    get all() { return lines.map((l) => JSON.parse(l)); },
  };
}

test('migrateManifestEvidence appends (never rewrites) re-attestation entries under the new id', () => {
  const base = [ev('T7', 'prosecution', 3, { verdict: 'clear' })];
  const lg = fakeLedger(base);
  const appended = [];
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:acme/app#7', {
    now: '2026-06-27T00:00:00Z',
    env: {},
    read: lg.read,
    append: (name, entry) => { appended.push(entry); lg.append(name, entry); },
    readRaw: lg.readRaw,
  });
  assert.equal(r.migrated, 1);
  // The original entry is untouched; a NEW entry is appended.
  assert.equal(lg.all[0].ticket, 'T7', 'history is immutable — old entry unchanged');
  const re = appended[0];
  assert.equal(re.ticket, 'gh:acme/app#7');
  assert.equal(re.gate, 'prosecution');
  assert.equal(re.data.verdict, 'clear', 'verdict carried forward');
  assert.equal(re.data.migratedFrom, 'T7');
  assert.equal(re.seq, 4, 'seq continues the chain');
  // The chain link must be the EXACT sha256 of the prior raw ledger line — not just
  // 64 hex chars. A wrong value silently breaks the tamper-evident chain.
  assert.equal(re.prev, sha256(JSON.stringify(base[0])), 'prev = sha256(exact prior raw line)');
});

test('migrateManifestEvidence chains a multi-gate migration correctly (entry N links to N-1)', () => {
  // A real ticket can carry evidence in >1 gate (e.g. p0 + prosecution) → 2 appended
  // rows. Row 2 MUST chain off row 1's raw bytes, or the ledger is broken.
  const base = [ev('T7', 'p0', 1), ev('T7', 'prosecution', 2, { verdict: 'clear' })];
  const lg = fakeLedger(base);
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:r#9', {
    now: '2026-06-27T00:00:00Z', env: {}, read: lg.read, append: lg.append, readRaw: lg.readRaw,
  });
  assert.equal(r.migrated, 2);
  assert.equal(r.entries[0].prev, sha256(JSON.stringify(base[base.length - 1])), 'first re-attestation links to the seeded tail');
  assert.equal(r.entries[1].prev, sha256(JSON.stringify(r.entries[0])), 'second re-attestation links to the first');
  assert.deepEqual(r.entries.map((e) => e.seq), [3, 4], 'seqs ascend without collision');
});

test('migrateManifestEvidence signs re-attestation entries when ADLC_MANIFEST_KEY is set', () => {
  const lg = fakeLedger([ev('T7', 'prosecution', 1, { verdict: 'clear' })]);
  const KEY = 'secret-key';
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:r#2', {
    now: '2026-06-27T00:00:00Z', env: { ADLC_MANIFEST_KEY: KEY },
    read: lg.read, append: lg.append, readRaw: lg.readRaw,
  });
  const e = r.entries[0];
  // Recompute the expected sig over the documented canonical byte order.
  const c = { seq: e.seq, gate: e.gate, ts: e.ts, ticket: e.ticket, data: e.data, files: e.files, prev: e.prev };
  const expected = createHmac('sha256', KEY).update(JSON.stringify(c)).digest('hex');
  assert.equal(e.sig, expected, 'sig matches gate-manifest canonicalEntryBytes order');
});

test('migrateManifestEvidence is a no-op (no append) when there is no evidence', () => {
  const lg = fakeLedger([ev('T8', 'prosecution', 1)]);
  let appends = 0;
  const r = migrateManifestEvidence('/repo', 'T7', 'gh:r#2', {
    now: 'T', env: {}, read: lg.read, append: () => { appends += 1; }, readRaw: lg.readRaw,
  });
  assert.equal(r.migrated, 0);
  assert.equal(appends, 0);
});
