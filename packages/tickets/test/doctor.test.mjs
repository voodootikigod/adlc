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
// last evidence-required transaction bound in .adlc/manifest.jsonl, so a silent
// shard hand-edit between transactions went undetected. The check now binds them:
//   - clean store (hash == last bound storeHash) → pass;
//   - hash drifted but the evidenced ticket(s) still match → legit unevidenced
//     non-sensitive op(s), REPORTED not failed;
//   - an evidenced ticket that no longer matches its bound hash → tamper, FLAGGED.
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

test('doctor storehash-manifest-bind: a hand-edited shard (tamper) is flagged and fails the report', () => {
  const { root, store } = storeWithEvidence();
  try {
    // Hand-edit A's shard directly, bypassing the transaction machinery: keep the
    // id (so the filename still matches) but change the title. A's hash — and the
    // whole storeHash — now diverge from the evidence with no new manifest entry.
    const shard = join(root, '.adlc', 'tickets', ticketFilename('A'));
    const tampered = { ...JSON.parse(readFileSync(shard, 'utf8')), title: 'Silently edited' };
    writeFileSync(shard, prettyCanonicalJson(tampered));

    const report = doctorTicketStore(store, { root });
    const check = bindCheck(report);
    assert.equal(check.ok, false, 'the tamper is flagged');
    assert.equal(check.code, 'STOREHASH_MANIFEST_MISMATCH');
    assert.equal(report.ok, false, 'a tampered store fails the whole report');
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
