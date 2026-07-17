import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, doctorTicketStore } from '../index.mjs';
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
