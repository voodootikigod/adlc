import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, TicketService, doctorTicketStore, prettyCanonicalJson, ticketFilename } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

test('doctor is read-only and reports active/archive/runtime health', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-doctor-'));
  try {
    const path = writeDirectory(root, [ticket('A')]);
    const before = readdirSync(join(root, '.adlc')).sort();
    const report = doctorTicketStore(new DirectoryTicketStore(path), { root, archive: true });
    assert.equal(report.ok, true);
    assert.deepEqual(readdirSync(join(root, '.adlc')).sort(), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// current-ticket validation.
//
// This check used to be `{ok: true, present: existsSync(...)}` — it never parsed,
// resolved, or hash-checked, so a pointer naming already-merged work reported
// healthy right up until a hook failed closed on it. Doctor must answer the
// question that matters: would the gates accept this pointer?
// ---------------------------------------------------------------------------

function doctorWith(pointer, { raw = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-pointer-'));
  const path = writeDirectory(root, [ticket('A'), ticket('B')]);
  const store = new DirectoryTicketStore(path);
  const snapshot = store.load();
  if (pointer !== undefined) {
    const value = typeof pointer === 'function' ? pointer(snapshot) : pointer;
    writeFileSync(join(root, '.adlc/current-ticket.json'), raw ? value : JSON.stringify(value));
  }
  const report = doctorTicketStore(store, { root });
  return { report, check: report.checks.find((c) => c.name === 'current-ticket'), snapshot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('doctor current-ticket: absent pointer is healthy, not broken', () => {
  const d = doctorWith(undefined);
  try {
    assert.equal(d.check.ok, true);
    assert.equal(d.check.present, false);
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a canonical pointer is healthy and names the ticket', () => {
  const d = doctorWith((s) => ({ id: 'A', ticketHash: s.ticketHashes.A }));
  try {
    assert.equal(d.check.ok, true);
    assert.equal(d.check.id, 'A');
    assert.equal(d.check.deprecatedAlias, undefined);
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a deprecated alias resolves but is reported', () => {
  // The exact shape this repo's own pointer had. It must resolve (so nothing
  // bricks) AND be visible (so it gets migrated before 2.0 removes it).
  const d = doctorWith((s) => ({ ticketId: 'A', ticketHash: s.ticketHashes.A }));
  try {
    assert.equal(d.check.ok, true);
    assert.equal(d.check.id, 'A');
    assert.equal(d.check.deprecatedAlias, 'ticketId');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a stale hash is reported, not called healthy', () => {
  const d = doctorWith({ id: 'A', ticketHash: 'f'.repeat(64) });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'ACTIVE_TICKET_STALE');
    assert.equal(d.report.ok, false, 'a broken pointer must fail the whole report');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a pointer naming an absent ticket is reported', () => {
  const d = doctorWith({ id: 'GONE', ticketHash: 'f'.repeat(64) });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'ACTIVE_TICKET_MISSING');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: an unrecognized id key is reported, not treated as absent', () => {
  // The fail-open shape. Doctor must not shrug at a pointer the gates will deny.
  const d = doctorWith({ tickett: 'A' });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'INVALID_CURRENT_TICKET');
    assert.equal(d.check.present, true);
  } finally { d.cleanup(); }
});

test('doctor current-ticket: an unparseable pointer is reported', () => {
  const d = doctorWith('{not json', { raw: true });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'INVALID_CURRENT_TICKET');
  } finally { d.cleanup(); }
});

test('doctor current-ticket: a pointer pinning no ticketHash is reported (strict, as 2.0 will enforce)', () => {
  const d = doctorWith({ id: 'A' });
  try {
    assert.equal(d.check.ok, false);
    assert.equal(d.check.code, 'ACTIVE_TICKET_HASH_MISSING');
  } finally { d.cleanup(); }
});

// ---------------------------------------------------------------------------
// storeHash ↔ manifest evidence binding (T77).
//
// doctor reported the live storeHash but never compared it to the storeHash the
// last evidence-required transaction bound in .adlc/manifest.jsonl. The check now
// binds the store to that last evidenced CHECKPOINT and reports honestly — it does
// NOT adjudicate per-ticket tamper (unsound in this model: the ticket layer permits
// ordinary unevidenced updates, so a "changed since its evidence" signal both
// false-flags legitimately-edited evidenced tickets and misses hand-edits to
// never-evidenced ones — sound tamper-detection needs a store hash per transaction,
// a follow-up). Contract:
//   - clean store (hash == last bound storeHash) → pass, no drift;
//   - hash differs from the checkpoint → drift, REPORTED not failed (git history is
//     the record for the changed shards).
// ---------------------------------------------------------------------------

/** A directory store with ticket A authored and COMPLETED (so A carries manifest evidence). */
function storeWithEvidence(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-bind-'));
  writeDirectory(root, []); // empty directory store (.store.json only)
  const store = new DirectoryTicketStore(join(root, '.adlc', 'tickets'));
  const service = new TicketService(store, { root });
  service.apply(service.planCreate(ticket('A')));
  for (const t of extra) service.apply(service.planCreate(t));
  service.apply(service.planComplete('A')); // evidence-required → records bound storeHash + A's hash
  return { root, store, service };
}

const bindCheck = (report) => report.checks.find((c) => c.name === 'storehash-manifest-bind');

test('doctor storehash-manifest-bind: a clean store (unchanged since the last evidence) passes and binds', () => {
  const { root, store } = storeWithEvidence();
  try {
    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.ok(check, 'the storeHash↔manifest check is present');
    assert.equal(check.ok, true);
    assert.equal(check.bound, true);
    assert.notEqual(check.drift, true, 'no drift on a clean store');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a hand-edited shard surfaces as drift, deliberately NOT adjudicated as tamper', () => {
  const { root, store } = storeWithEvidence();
  try {
    // Hand-edit A's shard directly, bypassing the transaction machinery. The store
    // hash now diverges from the last evidenced checkpoint. This check reports the
    // drift but must NOT claim tamper — a per-ticket tamper signal is unsound here
    // (see the file header), so the honest output is drift, with git history as the
    // record for the changed shard.
    const shard = join(root, '.adlc', 'tickets', ticketFilename('A'));
    const edited = { ...JSON.parse(readFileSync(shard, 'utf8')), title: 'Silently edited' };
    writeFileSync(shard, prettyCanonicalJson(edited));

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.drift, true, 'the divergence from the checkpoint is surfaced');
    assert.notEqual(check.code, 'STOREHASH_MANIFEST_MISMATCH', 'but no false tamper claim is made');
    assert.equal(check.ok, true, 'and it is not failed — this check does not adjudicate tamper');
    assert.equal(report.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a legit later update of an EVIDENCED ticket is NOT flagged as tamper (no false positive)', () => {
  // The round-2 adversarial-review finding: an evidenced ticket that later receives
  // an ordinary non-sensitive update (permitted, unevidenced) must not be reported
  // as tampering. It is drift, reported, never a failure.
  const { root, store, service } = storeWithEvidence();
  try {
    const current = store.load().get('A');
    service.apply(service.planUpdate('A', { ...current, title: 'Legitimately edited later' }));

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, true, 'a legit unevidenced update of an evidenced ticket does not fail');
    assert.notEqual(check.code, 'STOREHASH_MANIFEST_MISMATCH', 'no false tamper claim');
    assert.equal(check.drift, true, 'it is surfaced as drift');
    assert.equal(report.ok, true, 'the report stays green on a valid repo');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a legitimate unevidenced op (create) is reported as drift, not failed', () => {
  const { root, store, service } = storeWithEvidence();
  try {
    // Creating B is a non-sensitive op that records NO manifest evidence, so the
    // live storeHash drifts from the last bound one — but A (the evidenced ticket)
    // is untouched. That is a legitimate state: reported, never failed.
    service.apply(service.planCreate(ticket('B')));

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, true, 'a legitimate unevidenced op does not fail the check');
    assert.equal(check.drift, true, 'but the drift is surfaced');
    assert.equal(report.ok, true, 'and the report stays green');
    // The message is honest that the drift is unverified by this check, not a claim
    // that the store is confirmed clean.
    assert.match(check.message, /does not verify|git history/i, 'the drift is reported as unverified, not adjudicated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a forged / chain-broken manifest is NOT trusted (no arbitrary checkpoint)', () => {
  const { root, store } = storeWithEvidence();
  try {
    // Append a forged entry asserting an arbitrary storeHash but with a broken
    // prev-link and out-of-sequence seq. The check must verify the hash chain and
    // refuse to adopt the forged hash — reporting the ledger unverifiable instead of
    // silently trusting the last syntactically-valid storeHash.
    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    const forged = JSON.stringify({ seq: 999, gate: 'forged', ts: '2026-01-01T00:00:00.000Z', data: { storeHash: 'deadbeefdeadbeef', bindingScope: 'store' }, prev: 'not-a-real-hash' });
    writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8') + forged + '\n');

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, false, 'a chain-invalid manifest FAILS the integrity check');
    assert.equal(report.ok, false, 'and fails the overall report — a detected corruption is never reported healthy');
    assert.notEqual(check.boundStoreHash, 'deadbeefdeadbeef', 'the forged storeHash is never adopted');
    assert.match(check.reason ?? '', /chain|FAILED|malformed/i, 'the broken chain is reported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor storehash-manifest-bind: a store with no recorded evidence yet is inert (not a failure)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-noevidence-'));
  try {
    const path = writeDirectory(root, [ticket('A')]); // shards written directly; no manifest
    const report = doctorTicketStore(new DirectoryTicketStore(path), { root });
    const check = bindCheck(report);
    assert.equal(check.ok, true);
    assert.equal(check.bound, false, 'nothing to bind against yet');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor current-ticket: reports that it could not validate when the store is unreadable', () => {
  // Bounded (the active-store check already failed, so the verdict is ok:false
  // either way) but report-only silence here would mislead: the operator must see
  // WHY the pointer was not validated, not an absent check.
  const root = mkdtempSync(join(tmpdir(), 'adlc-doctor-nostore-'));
  try {
    mkdirSync(join(root, '.adlc'), { recursive: true });
    writeFileSync(join(root, '.adlc/current-ticket.json'), JSON.stringify({ id: 'A', ticketHash: 'x'.repeat(64) }));
    const broken = new DirectoryTicketStore(join(root, '.adlc/tickets'));
    const report = doctorTicketStore(broken, { root });
    const check = report.checks.find((c) => c.name === 'current-ticket');
    assert.equal(check.ok, false);
    assert.equal(check.code, 'ACTIVE_STORE_UNREADABLE');
    assert.equal(report.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
