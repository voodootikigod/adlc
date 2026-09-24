import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { classifyDenyRecord, doctorReport, ORPHAN_MIN_AGE_MS } from '../lib/doctor.mjs';
import { ensureDenyMarker, loadDenyRecords, readDenyMarker } from '../lib/deny-marker.mjs';
import { writeDenyRecord } from '../lib/deny-persist.mjs';
import { writeFinal } from '../lib/final.mjs';

const scratch = (t) => tmp(t, 'handoff-doctor-');

test('classifyDenyRecord: ORPHANED-UNBOUND is exactly open + null ticket + null hash + no capture; every near-miss classifies differently', () => {
  const old = new Date(Date.now() - 2 * ORPHAN_MIN_AGE_MS).toISOString();
  const orphan = { session_id: 's1', ticket_id: null, content_hash: null, status: 'open', since: old };
  assert.equal(classifyDenyRecord(orphan, { hasCapture: false }).kind, 'orphaned-unbound');
  // A LIVE session's deny looks identical for a window: a fresh record is never an orphan (agy r2).
  assert.equal(classifyDenyRecord({ ...orphan, since: new Date().toISOString() }, { hasCapture: false }).kind, 'recent-unbound');
  assert.equal(classifyDenyRecord({ ...orphan, since: 'not-a-date' }, { hasCapture: false }).kind, 'recent-unbound', 'an unparseable since is never clearable');
  assert.equal(classifyDenyRecord({ ...orphan, ticket_id: 'T1' }, { hasCapture: false }).kind, 'bound');
  assert.equal(classifyDenyRecord({ ...orphan, content_hash: 'h' }, { hasCapture: false }).kind, 'bound');
  assert.equal(classifyDenyRecord(orphan, { hasCapture: true }).kind, 'captured');
  assert.equal(classifyDenyRecord({ ...orphan, status: 'consumed' }, { hasCapture: false }).kind, 'closed');
});

test('doctorReport over a real store: an orphan is reported with its clear command; a bound deny and a captured deny are NOT clearable; a clean store reports none', (t) => {
  const root = scratch(t);
  ensureDenyMarker(root, { sessionId: 'orphan-a', host: 'pi' }, { now: () => new Date(Date.now() - 2 * ORPHAN_MIN_AGE_MS).toISOString() });
  ensureDenyMarker(root, { sessionId: 'bound-b', ticketId: 'T9', contentHash: 'c'.repeat(64), host: 'pi' });
  ensureDenyMarker(root, { sessionId: 'captured-c', host: 'pi' });
  writeFinal(root, { sessionId: 'captured-c', ticketId: null, contentHash: null, host: 'pi' });
  const r = doctorReport(root);
  assert.equal(r.ok, true);
  assert.deepEqual(r.orphans.map((o) => o.session_id).sort(), ['orphan-a']);
  assert.deepEqual(r.records.map((x) => [x.session_id, x.kind]).sort(), [['bound-b', 'bound'], ['captured-c', 'captured'], ['orphan-a', 'orphaned-unbound']]);
  assert.match(r.clearCommand, /doctor --clear/, 'the report names the exact clear command');
});

test('provenance: new deny records carry writer {pid, argv0, cwd, host, wroteAt}; readers tolerate records without it; loadDenyRecords passes it through', (t) => {
  const root = scratch(t);
  ensureDenyMarker(root, { sessionId: 'with-prov', host: 'pi' });
  const rec = readDenyMarker(root, 'with-prov').record;
  assert.equal(typeof rec.writer, 'object');
  assert.equal(rec.writer.pid, process.pid);
  assert.equal(typeof rec.writer.argv0, 'string');
  assert.ok(!rec.writer.argv0.includes('/'), 'argv0 is a basename, never a path');
  assert.equal(rec.writer.argv0, 'doctor.test.mjs', 'exactly the entry script basename');
  assert.equal(rec.writer.cwd, process.cwd());
  assert.ok(rec.writer.wroteAt);
  // A record written without provenance (the pre-provenance schema) still loads and classifies.
  const legacy = writeDenyRecord(root, { session_id: 'legacy-l', ticket_id: null, content_hash: null, status: 'open', since: new Date(Date.now() - 2 * ORPHAN_MIN_AGE_MS).toISOString(), host: 'pi', schema: 1 });
  assert.equal(legacy.ok, true);
  const loaded = loadDenyRecords(root);
  assert.equal(loaded.ok, true);
  const l = loaded.records.find((x) => x.session_id === 'legacy-l');
  assert.equal(l.writer, undefined);
  assert.equal(classifyDenyRecord(l, { hasCapture: false }).kind, 'orphaned-unbound');
});

test('a legacy-only sentinel is merged, never discarded: the first clear keeps bound sessions registered (agy r1 #1)', async (t) => {
  const { writeFileSync, mkdirSync, renameSync } = await import('node:fs');
  const root = scratch(t);
  ensureDenyMarker(root, { sessionId: 'orphan-a', host: 'pi' }, { now: () => new Date(Date.now() - 2 * ORPHAN_MIN_AGE_MS).toISOString() });
  ensureDenyMarker(root, { sessionId: 'bound-b', ticketId: 'T9', contentHash: 'c'.repeat(64), host: 'pi' });
  // Simulate the pre-slice layout: registrations live ONLY in the legacy file.
  mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
  renameSync(join(root, '.adlc', '.deny-store'), join(root, '.adlc', 'handoffs', '.deny-store'));
  const { doctorClear } = await import('../lib/doctor.mjs');
  const r = doctorClear(root, { key: 'd'.repeat(64), dir: join(root, '.adlc') });
  assert.equal(r.ok, true);
  const sentinel = JSON.parse(readFileSync(join(root, '.adlc', '.deny-store'), 'utf8'));
  assert.ok(sentinel.sessions.includes('bound-b'), 'the bound session registration survived the migration');
  assert.ok(!sentinel.sessions.includes('orphan-a'));
  assert.ok(!existsSync(join(root, '.adlc', 'handoffs', '.deny-store')), 'the legacy file is healed away');
});

test('a partial unlink failure still updates the sentinel and records evidence for what WAS cleared (agy r1 #2)', async (t) => {
  const { unlinkSync: realUnlink } = await import('node:fs');
  const root = scratch(t);
  ensureDenyMarker(root, { sessionId: 'orphan-a', host: 'pi' }, { now: () => new Date(Date.now() - 2 * ORPHAN_MIN_AGE_MS).toISOString() });
  ensureDenyMarker(root, { sessionId: 'orphan-z', host: 'pi' }, { now: () => new Date(Date.now() - 2 * ORPHAN_MIN_AGE_MS).toISOString() });
  const { doctorClear } = await import('../lib/doctor.mjs');
  const fs = { unlinkSync: (p) => { if (p.includes('orphan-z')) throw new Error('EACCES simulated'); return realUnlink(p); } };
  const r = doctorClear(root, { key: 'd'.repeat(64), dir: join(root, '.adlc'), fs });
  assert.equal(r.ok, false);
  assert.deepEqual(r.cleared, ['orphan-a']);
  const sentinel = JSON.parse(readFileSync(join(root, '.adlc', '.deny-store'), 'utf8'));
  assert.ok(!sentinel.sessions.includes('orphan-a'), 'the removed record left the sentinel');
  assert.ok(sentinel.sessions.includes('orphan-z'), 'the still-present record stays registered');
  const manifest = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8');
  const entry = manifest.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.gate === 'handoff-doctor-clear');
  assert.ok(entry && entry.data.partial === true && entry.data.failed.session_id === 'orphan-z', 'the evidence names the partial failure');
});
