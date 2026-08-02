import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureDenyMarker,
  readDenyMarker,
  evaluateMarkerOnReentry,
  denyPath,
  quarantineJunkDenies,
  assertSafeSessionId,
} from '../lib/deny-marker.mjs';

test('ensureDenyMarker writes readable open record', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const r = ensureDenyMarker(root, { sessionId: 'sess-a', ticketId: 'T154', contentHash: 'h1' });
    assert.equal(r.ok, true);
    assert.equal(r.processSticky, false);
    const check = readDenyMarker(root, 'sess-a');
    assert.equal(check.ok, true);
    assert.equal(check.record.status, 'open');
    assert.equal(check.record.ticket_id, 'T154');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker normalizes empty bind fields to null', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const r = ensureDenyMarker(root, { sessionId: 'empty-bind', ticketId: '  ', contentHash: '' });
    assert.equal(r.ok, true);
    const check = readDenyMarker(root, 'empty-bind');
    assert.equal(check.record.ticket_id, null);
    assert.equal(check.record.content_hash, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker does not clobber consumed marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'sess-consumed');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        session_id: 'sess-consumed',
        ticket_id: 'T154',
        content_hash: 'bound-hash',
        status: 'consumed',
        since: '2026-01-01T00:00:00.000Z',
        host: 'host',
        schema: 1,
      }),
      'utf8',
    );
    const r = ensureDenyMarker(root, {
      sessionId: 'sess-consumed',
      ticketId: 'OTHER',
      contentHash: 'clobber',
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'already_present');
    const check = readDenyMarker(root, 'sess-consumed');
    assert.equal(check.record.status, 'consumed');
    assert.equal(check.record.ticket_id, 'T154');
    assert.equal(check.record.content_hash, 'bound-hash');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker does not clobber host-repaired ticket_id/content_hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'sess-repaired');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        session_id: 'sess-repaired',
        ticket_id: 'T154',
        content_hash: 'host-bound',
        status: 'open',
        since: '2026-01-01T00:00:00.000Z',
        host: 'repair',
        schema: 1,
      }),
      'utf8',
    );
    const before = readFileSync(path, 'utf8');
    const r = ensureDenyMarker(root, {
      sessionId: 'sess-repaired',
      ticketId: null,
      contentHash: null,
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'already_present');
    assert.equal(readFileSync(path, 'utf8'), before);
    const check = readDenyMarker(root, 'sess-repaired');
    assert.equal(check.record.ticket_id, 'T154');
    assert.equal(check.record.content_hash, 'host-bound');
    assert.equal(check.record.status, 'open');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker does not clobber unreadable existing marker', () => {
  let reads = 0;
  const fs = {
    mkdirSync() {},
    writeFileSync() {
      throw new Error('should not write');
    },
    renameSync() {
      throw new Error('should not rename');
    },
    existsSync() {
      return true;
    },
    readFileSync() {
      reads += 1;
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  };
  const r = ensureDenyMarker('/x', { sessionId: 's', ticketId: 'T', contentHash: 'h' }, { fs });
  assert.equal(r.ok, false);
  assert.equal(r.processSticky, true);
  assert.equal(r.reason, 'unreadable_marker');
  assert.ok(reads >= 1);
});

test('ensureDenyMarker rewrites corrupt marker into valid open', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'corrupt-repair');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');
    assert.equal(readDenyMarker(root, 'corrupt-repair').reason, 'corrupt_json');
    const r = ensureDenyMarker(root, {
      sessionId: 'corrupt-repair',
      ticketId: 'T154',
      contentHash: 'h1',
    });
    assert.equal(r.ok, true);
    const check = readDenyMarker(root, 'corrupt-repair');
    assert.equal(check.ok, true);
    assert.equal(check.record.status, 'open');
    assert.equal(check.record.ticket_id, 'T154');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('path traversal sessionId rejected', () => {
  assert.throws(() => assertSafeSessionId('../escape'), /unsafe sessionId/);
  assert.throws(() => assertSafeSessionId('a/b'), /unsafe sessionId/);
  assert.throws(() => assertSafeSessionId('a\\b'), /unsafe sessionId/);
  assert.throws(() => assertSafeSessionId(''), /unsafe sessionId/);
  assert.throws(() => denyPath('/tmp', '../escape'), /unsafe sessionId/);
  assert.throws(() => ensureDenyMarker('/tmp', { sessionId: '..' }), /unsafe sessionId/);
  assert.throws(
    () => evaluateMarkerOnReentry('/tmp', 'foo/../bar', { absoluteHandoff: false }),
    /unsafe sessionId/,
  );
});

test('quarantineJunkDenies moves junk on disk, leaves valid marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const denies = join(root, '.adlc', 'handoffs', 'denies');
    mkdirSync(denies, { recursive: true });
    ensureDenyMarker(root, { sessionId: 'good', ticketId: 'T154', contentHash: 'h1' });
    writeFileSync(join(denies, 'notes.txt'), 'not json', 'utf8');
    writeFileSync(join(denies, 'pending.tmp'), 'tmp', 'utf8');
    const result = quarantineJunkDenies(root);
    assert.equal(result.ok, true);
    assert.ok(result.kept.includes('good.json'));
    assert.ok(result.quarantined.includes('notes.txt'));
    assert.ok(!result.quarantined.includes('pending.tmp'));
    assert.equal(existsSync(join(denies, 'notes.txt')), false);
    assert.ok(existsSync(join(denies, 'quarantine')));
    const qNames = readdirSync(join(denies, 'quarantine'));
    assert.ok(qNames.some((n) => n.startsWith('notes.txt.')));
    assert.equal(readDenyMarker(root, 'good').ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quarantineJunkDenies retains corrupt self-named marker for deny', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const denies = join(root, '.adlc', 'handoffs', 'denies');
    mkdirSync(denies, { recursive: true });
    writeFileSync(join(denies, 'self.json'), '{not-json', 'utf8');
    const result = quarantineJunkDenies(root);
    assert.ok(result.retainedForDeny.includes('self.json'));
    assert.ok(!result.quarantined.includes('self.json'));
    assert.equal(existsSync(join(denies, 'self.json')), true);
    const cool = evaluateMarkerOnReentry(root, 'self', { absoluteHandoff: false });
    assert.equal(cool.deny, true);
    assert.equal(cool.reason, 'corrupt_json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('consumed marker still denies on cooling reentry', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'cool-consumed');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        session_id: 'cool-consumed',
        ticket_id: 'T154',
        content_hash: 'h',
        status: 'consumed',
        schema: 1,
      }),
      'utf8',
    );
    const r = evaluateMarkerOnReentry(root, 'cool-consumed', { absoluteHandoff: false });
    assert.equal(r.deny, true);
    assert.equal(r.reason, 'consumed_deny_persists');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing marker reason is exactly missing_marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const check = readDenyMarker(root, 'absent');
    assert.equal(check.ok, false);
    assert.equal(check.deny, true);
    assert.equal(check.reason, 'missing_marker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt marker ⇒ deny fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'sess-b');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(path, '{not-json', 'utf8');
    const check = readDenyMarker(root, 'sess-b');
    assert.equal(check.ok, false);
    assert.equal(check.deny, true);
    assert.equal(check.reason, 'corrupt_json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session_id mismatch ⇒ deny', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'sess-c');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(path, JSON.stringify({ session_id: 'OTHER', status: 'open' }), 'utf8');
    const check = readDenyMarker(root, 'sess-c');
    assert.equal(check.deny, true);
    assert.equal(check.reason, 'session_id_mismatch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write failure ⇒ processSticky', () => {
  const fs = {
    mkdirSync() {},
    writeFileSync() {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
    renameSync() {},
    existsSync() {
      return false;
    },
    readFileSync() {
      throw new Error('nope');
    },
  };
  const r = ensureDenyMarker('/x', { sessionId: 's' }, { fs });
  assert.equal(r.ok, false);
  assert.equal(r.processSticky, true);
});

test('re-entry with absolute handoff + missing marker ⇒ sticky deny + retry', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const r = evaluateMarkerOnReentry(root, 'missing', { absoluteHandoff: true });
    assert.equal(r.deny, true);
    assert.equal(r.processSticky, true);
    assert.equal(r.retryWrite, true);
    assert.equal(r.reason, 'missing_marker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('open deny persists when absolute cools below handoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 'cool', ticketId: null, contentHash: null });
    const r = evaluateMarkerOnReentry(root, 'cool', { absoluteHandoff: false });
    assert.equal(r.deny, true);
    assert.equal(r.reason, 'open_deny_persists');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid_status marker denies on cool reentry', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'bad-status');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ session_id: 'bad-status', status: 'bogus', schema: 1 }),
      'utf8',
    );
    const check = readDenyMarker(root, 'bad-status');
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'invalid_status');
    const cool = evaluateMarkerOnReentry(root, 'bad-status', { absoluteHandoff: false });
    assert.equal(cool.deny, true);
    assert.equal(cool.reason, 'invalid_status');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('absolute handoff + valid marker ⇒ handoff_active deny', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 'active', ticketId: 'T154', contentHash: 'h' });
    const r = evaluateMarkerOnReentry(root, 'active', { absoluteHandoff: true });
    assert.equal(r.deny, true);
    assert.equal(r.processSticky, false);
    assert.equal(r.reason, 'handoff_active');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
