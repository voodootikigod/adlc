import { evaluateMutationGate } from '../lib/mutation-gate.mjs';
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
  renameSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureDenyMarker,
  readDenyMarker,
  evaluateMarkerOnReentry,
  denyPath,
  quarantineJunkDenies,
  assertSafeSessionId,
  isSafeSessionId,
  loadDenyRecords,
  mutationGateInputFromLoad,
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

test('ensureDenyMarker quarantines corrupt marker then writes valid open', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'corrupt-repair');
    const denies = join(root, '.adlc', 'handoffs', 'denies');
    mkdirSync(denies, { recursive: true });
    const oldBytes = '{not-json';
    writeFileSync(path, oldBytes, 'utf8');
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
    const qDir = join(denies, 'quarantine');
    assert.equal(existsSync(qDir), true);
    const qNames = readdirSync(qDir);
    const hit = qNames.find((n) => n.startsWith('corrupt-repair.json.corrupt_json.'));
    assert.ok(hit, `expected quarantine entry, got ${qNames.join(',')}`);
    assert.equal(readFileSync(join(qDir, hit), 'utf8'), oldBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker refuses session_id_mismatch without overwrite', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'sess-c');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    const bytes = JSON.stringify({
      session_id: 'OTHER',
      ticket_id: 'T154',
      content_hash: 'host-bound',
      status: 'open',
      schema: 1,
    });
    writeFileSync(path, bytes, 'utf8');
    const r = ensureDenyMarker(root, {
      sessionId: 'sess-c',
      ticketId: 'NEW',
      contentHash: 'clobber',
    });
    assert.equal(r.ok, false);
    assert.equal(r.processSticky, true);
    assert.equal(r.reason, 'session_id_mismatch');
    assert.equal(readFileSync(path, 'utf8'), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker refuses invalid_status without destroying binds', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const path = denyPath(root, 'bad-status-rewrite');
    mkdirSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true });
    const bytes = JSON.stringify({
      session_id: 'bad-status-rewrite',
      ticket_id: 'T154',
      content_hash: 'HOST-BOUND-HASH',
      status: 'expired',
      schema: 2,
    });
    writeFileSync(path, bytes, 'utf8');
    const r = ensureDenyMarker(root, {
      sessionId: 'bad-status-rewrite',
      ticketId: null,
      contentHash: null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.processSticky, true);
    assert.equal(r.reason, 'invalid_status');
    assert.equal(readFileSync(path, 'utf8'), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('path traversal sessionId rejected', () => {
  assert.throws(() => assertSafeSessionId('../escape'), /unsafe sessionId/);
  assert.throws(() => assertSafeSessionId('a/b'), /unsafe sessionId/);
  assert.throws(() => assertSafeSessionId('a\\b'), /unsafe sessionId/);
  assert.throws(() => assertSafeSessionId(''), /unsafe sessionId: empty/);
  assert.throws(() => assertSafeSessionId(null), /unsafe sessionId: empty/);
  assert.throws(() => assertSafeSessionId(1), /unsafe sessionId: empty/);
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

test('padded sessionId rejected by assertSafeSessionId/ensureDenyMarker', () => {
  assert.throws(() => assertSafeSessionId('denier '), /padded/);
  assert.throws(() => ensureDenyMarker('/tmp', { sessionId: 'denier ' }), /padded/);
});

test('isSafeSessionId matches assertSafeSessionId accept/reject set', () => {
  assert.equal(isSafeSessionId('sess-ok'), true);
  for (const id of ['', '  ', 'a/b', '../x', 'a\\b', '..', 'padded ']) {
    assert.equal(isSafeSessionId(id), false, JSON.stringify(id));
    assert.throws(() => assertSafeSessionId(id), /unsafe sessionId/);
  }
});

test('single-character sessionId is safe (kills length===0 off-by-one)', () => {
  assert.equal(isSafeSessionId('a'), true);
  assert.equal(assertSafeSessionId('a'), true);
  assert.equal(isSafeSessionId(''), false);
});

test('denyEverWritten + missing marker ⇒ marker_vanished fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const r = evaluateMarkerOnReentry(root, 'gone', {
      absoluteHandoff: false,
      denyEverWritten: true,
    });
    assert.equal(r.deny, true);
    assert.equal(r.processSticky, true);
    assert.equal(r.reason, 'marker_vanished');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('write-then-delete with denyEverWritten stays denied on cool reentry', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 'vanish', ticketId: null, contentHash: null });
    const path = denyPath(root, 'vanish');
    rmSync(path, { force: true });
    const cool = evaluateMarkerOnReentry(root, 'vanish', {
      absoluteHandoff: false,
      denyEverWritten: true,
    });
    assert.equal(cool.deny, true);
    assert.equal(cool.reason, 'marker_vanished');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadDenyRecords surfaces valid + invalid retained markers for the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const denies = join(root, '.adlc', 'handoffs', 'denies');
    mkdirSync(denies, { recursive: true });
    ensureDenyMarker(root, { sessionId: 'open1', ticketId: 'T154', contentHash: 'h1' });
    writeFileSync(
      join(denies, 'consumed1.json'),
      JSON.stringify({
        session_id: 'consumed1',
        ticket_id: 'T154',
        content_hash: 'h2',
        status: 'consumed',
        schema: 1,
      }),
      'utf8',
    );
    writeFileSync(join(denies, 'corrupt1.json'), '{not-json', 'utf8');
    writeFileSync(join(denies, 'notes.txt'), 'junk', 'utf8');
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.records.length, 2);
    assert.ok(loaded.records.some((r) => r.session_id === 'open1' && r.status === 'open'));
    assert.ok(loaded.records.some((r) => r.session_id === 'consumed1' && r.status === 'consumed'));
    assert.ok(loaded.invalidRecords.some((r) => r.session_id === 'corrupt1'));
    const g = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(g.deny, true);
    assert.ok(g.reasons.some((r) => r.includes('open1')));
    assert.ok(g.reasons.some((r) => r.startsWith('D3:invalid_record:corrupt1')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadDenyRecords readdir failure sets denyStoreUnavailable + sentinel', () => {
  const fs = {
    existsSync() { return true; },
    readdirSync() { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    readFileSync() { throw new Error('nope'); },
  };
  const loaded = loadDenyRecords('/x', { fs });
  assert.equal(loaded.ok, false);
  assert.equal(loaded.denyStoreUnavailable, true);
  assert.ok(loaded.invalidRecords.some((r) => r.session_id === '__deny_store__'));
  const g = evaluateMutationGate({
    currentSessionId: 'fresh',
    denyRecords: [...loaded.records, ...loaded.invalidRecords],
    denyStoreUnavailable: loaded.denyStoreUnavailable,
  });
  assert.equal(g.deny, true);
  assert.ok(g.reasons.includes('D0:deny_store_unavailable'));
});

test('storeExpected missing denies/ ⇒ denyStoreUnavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const loaded = loadDenyRecords(root, { storeExpected: true });
    assert.equal(loaded.ok, false);
    assert.equal(loaded.denyStoreUnavailable, true);
    const input = mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' });
    const g = evaluateMutationGate(input);
    assert.equal(g.deny, true);
    assert.ok(g.reasons.includes('D0:deny_store_unavailable'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing denies/ without storeExpected is a clean empty store', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.denyStoreUnavailable, false);
    const g = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(g.deny, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ticket-store markers alone do not expect a deny store', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    mkdirSync(join(root, '.adlc', 'tickets'), { recursive: true });
    writeFileSync(join(root, '.adlc', '.store.json'), '{}\n', 'utf8');
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.denyStoreUnavailable, false);
    const g = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(g.deny, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quarantineJunkDenies reports failure when rename throws', () => {
  const fs = {
    existsSync(path) {
      // Directory exists; quarantine destinations do not.
      return !String(path).includes(`${'quarantine'}`);
    },
    readdirSync() {
      return [{ name: 'notes.txt', isDirectory: () => false }];
    },
    mkdirSync() {},
    renameSync() {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
    readFileSync() { return ''; },
  };
  const result = quarantineJunkDenies('/x', { fs });
  assert.equal(result.ok, false);
  assert.match(result.reason, /quarantine_failed/);
});

test('.deny-store sentinel keeps storeExpected after denies/ removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 's1', ticketId: 'T154', contentHash: 'h' });
    assert.equal(existsSync(join(root, '.adlc', '.deny-store')), true);
    rmSync(join(root, '.adlc', 'handoffs', 'denies'), { recursive: true, force: true });
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.denyStoreUnavailable, true);
    const g = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(g.deny, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});



test('sentinel + emptied denies/ (files deleted, dir kept) is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 's1', ticketId: 'T154', contentHash: 'h' });
    const denies = join(root, '.adlc', 'handoffs', 'denies');
    for (const name of readdirSync(denies)) {
      if (name === 'quarantine') continue;
      rmSync(join(denies, name), { force: true, recursive: true });
    }
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.ok, false);
    assert.equal(loaded.reason, 'emptied_deny_store');
    assert.equal(loaded.denyStoreUnavailable, true);
    const g = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(g.deny, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('registered session or denyEverWritten makes cool reentry deny when marker vanished', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 'vanish2', ticketId: null, contentHash: null });
    rmSync(denyPath(root, 'vanish2'), { force: true });
    // Session was registered in sentinel — selective delete still fails closed.
    const registered = evaluateMarkerOnReentry(root, 'vanish2', { absoluteHandoff: false });
    assert.equal(registered.deny, true);
    assert.equal(registered.reason, 'marker_vanished');
    // Never-denied stranger is not sticky-denied by the global bit alone.
    const stranger = evaluateMarkerOnReentry(root, 'other', { absoluteHandoff: false });
    assert.equal(stranger.deny, false);
    assert.equal(stranger.reason, 'no_handoff_no_marker');
    const cool = evaluateMarkerOnReentry(root, 'fresh', {
      absoluteHandoff: false,
      denyEverWritten: true,
    });
    assert.equal(cool.deny, true);
    assert.equal(cool.reason, 'marker_vanished');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('sentinel self-heals when markers exist but sentinel was deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 'heal', ticketId: 'T154', contentHash: 'h' });
    const sentinel = join(root, '.adlc', '.deny-store');
    rmSync(sentinel, { force: true });
    assert.equal(existsSync(sentinel), false);
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.ok, true);
    assert.equal(existsSync(sentinel), true);
    // already_present path also heals
    rmSync(sentinel, { force: true });
    ensureDenyMarker(root, { sessionId: 'heal', ticketId: 'T154', contentHash: 'h' });
    assert.equal(existsSync(sentinel), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('rm -rf handoffs/ still denies when .adlc/.deny-store remains', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 's1', ticketId: 'T154', contentHash: 'h' });
    assert.equal(existsSync(join(root, '.adlc', '.deny-store')), true);
    rmSync(join(root, '.adlc', 'handoffs'), { recursive: true, force: true });
    assert.equal(existsSync(join(root, '.adlc', 'handoffs')), false);
    assert.equal(existsSync(join(root, '.adlc', '.deny-store')), true);
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.denyStoreUnavailable, true);
    const g = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(g.deny, true);
    assert.ok(g.reasons.includes('D0:deny_store_unavailable'));
    // s1 was registered in the sentinel — selective/whole wipe still sticky-denies s1.
    const cool = evaluateMarkerOnReentry(root, 's1', { absoluteHandoff: false });
    assert.equal(cool.deny, true);
    assert.equal(cool.reason, 'marker_vanished');
    const stranger = evaluateMarkerOnReentry(root, 'stranger', { absoluteHandoff: false });
    assert.equal(stranger.deny, false);
    assert.equal(stranger.reason, 'no_handoff_no_marker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy handoffs/.deny-store migrates to .adlc/.deny-store', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    mkdirSync(join(root, '.adlc', 'handoffs'), { recursive: true });
    writeFileSync(join(root, '.adlc', 'handoffs', '.deny-store'), '1\n', 'utf8');
    const newSentinel = join(root, '.adlc', '.deny-store');
    assert.equal(existsSync(newSentinel), false);
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.denyStoreUnavailable, true);
    assert.equal(existsSync(newSentinel), true);
    const g = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(g.deny, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quarantineJunkDenies continues after first rename failure', () => {
  const quarantinedDests = [];
  const fs = {
    existsSync(path) {
      const s = String(path);
      // Quarantine destination uniqueness probe — none exist yet.
      if (s.includes('/quarantine/')) return quarantinedDests.includes(s);
      return true;
    },
    readdirSync() {
      return [
        { name: 'a-locked.bin', isDirectory: () => false },
        { name: 'b-junk.txt', isDirectory: () => false },
        { name: 'c-valid.json', isDirectory: () => false },
      ];
    },
    mkdirSync() {},
    renameSync(from, to) {
      if (String(from).endsWith('a-locked.bin')) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      quarantinedDests.push(String(to));
    },
    readFileSync(path) {
      if (String(path).endsWith('c-valid.json')) {
        return JSON.stringify({
          session_id: 'c-valid',
          ticket_id: 'T154',
          content_hash: 'h',
          status: 'open',
          schema: 1,
        });
      }
      return '';
    },
  };
  const result = quarantineJunkDenies('/x', { fs });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['a-locked.bin']);
  assert.ok(result.quarantined.includes('b-junk.txt'), `expected b-junk quarantined, got ${result.quarantined}`);
  assert.ok(result.kept.includes('c-valid.json'));
  assert.ok(!result.quarantined.includes('a-locked.bin'));
});

test('loadDenyRecords surfaces EACCES self-named marker as invalid:unreadable_marker', () => {
  const fs = {
    existsSync() {
      return true;
    },
    readdirSync() {
      return [
        { name: 'self.json', isDirectory: () => false },
        { name: 'good.json', isDirectory: () => false },
      ];
    },
    readFileSync(path) {
      if (String(path).endsWith('self.json')) {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }
      return JSON.stringify({
        session_id: 'good',
        ticket_id: 'T154',
        content_hash: 'h',
        status: 'open',
        schema: 1,
      });
    },
    mkdirSync() {},
    writeFileSync() {},
  };
  const loaded = loadDenyRecords('/x', { fs });
  assert.equal(loaded.ok, true);
  assert.ok(loaded.records.some((r) => r.session_id === 'good'));
  const bad = loaded.invalidRecords.find((r) => r.session_id === 'self');
  assert.ok(bad, 'expected invalid record for self');
  assert.equal(bad.status, 'invalid:unreadable_marker');
  const g = evaluateMutationGate(
    mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
  );
  assert.equal(g.deny, true);
  assert.ok(
    g.reasons.some((r) => r.startsWith('D3:invalid_record:self')),
    `expected D3 invalid self, got ${g.reasons}`,
  );
});


test('non-denier cool reentry is not sticky-denied by live sentinel', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 'A', ticketId: 'T154', contentHash: 'h' });
    assert.equal(existsSync(join(root, '.adlc', '.deny-store')), true);
    const cool = evaluateMarkerOnReentry(root, 'B', { absoluteHandoff: false });
    assert.equal(cool.deny, false);
    assert.equal(cool.reason, 'no_handoff_no_marker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker write failure does not leave sentinel without marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const realFs = {
      mkdirSync,
      writeFileSync(path, data, enc) {
        if (String(path).endsWith('.tmp')) {
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        }
        return writeFileSync(path, data, enc);
      },
      renameSync,
      existsSync,
      readFileSync,
    };
    const r = ensureDenyMarker(
      root,
      { sessionId: 'partial', ticketId: 'T154', contentHash: 'h' },
      { fs: realFs },
    );
    assert.equal(r.ok, false);
    assert.match(r.reason, /write_failed/);
    assert.equal(existsSync(join(root, '.adlc', '.deny-store')), false);
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.denyStoreUnavailable, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutationGateInputFromLoad fails closed on malformed/absent load', () => {
  for (const loaded of [undefined, null, {}, { records: 'x', ok: true }, { records: [], ok: true }]) {
    const input = mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' });
    assert.equal(input.denyStoreUnavailable, true, JSON.stringify(loaded));
    const g = evaluateMutationGate(input);
    assert.equal(g.deny, true);
    assert.ok(g.reasons.includes('D0:deny_store_unavailable'));
  }
  // Well-formed empty store still allows.
  const ok = mutationGateInputFromLoad(
    { ok: true, records: [], invalidRecords: [], denyStoreUnavailable: false },
    { currentSessionId: 'fresh' },
  );
  assert.equal(ok.denyStoreUnavailable, false);
  assert.equal(evaluateMutationGate(ok).deny, false);
});


test('evaluateMarkerOnReentry requires strict boolean absoluteHandoff', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    for (const bad of [undefined, null, 'false', 1, {}]) {
      const r = evaluateMarkerOnReentry(root, 'never', { absoluteHandoff: bad });
      assert.equal(r.deny, true, JSON.stringify(bad));
      assert.equal(r.reason, 'invalid_handoff_signal');
      assert.equal(r.processSticky, true);
    }
    const cool = evaluateMarkerOnReentry(root, 'never', { absoluteHandoff: false });
    assert.equal(cool.deny, false);
    assert.equal(cool.reason, 'no_handoff_no_marker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('selective delete of open deny keeps D3 for all sessions via registeredSessions', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    ensureDenyMarker(root, { sessionId: 'denier', ticketId: 'T154', contentHash: 'h' });
    ensureDenyMarker(root, { sessionId: 'other', ticketId: 'T154', contentHash: 'h2' });
    rmSync(denyPath(root, 'denier'), { force: true });
    const loaded = loadDenyRecords(root);
    assert.ok(loaded.registeredSessions.includes('denier'));
    assert.ok(
      loaded.invalidRecords.some(
        (r) => r.session_id === 'denier' && r.status === 'invalid:missing_registered_marker',
      ),
    );
    const denierG = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'denier' }),
    );
    assert.equal(denierG.deny, true);
    assert.ok(
      denierG.reasons.includes('D2:denier_session') ||
        denierG.reasons.some((r) => r.startsWith('D3:invalid_record:denier')),
      JSON.stringify(denierG.reasons),
    );
    // Fresh session must still be denied (D3), not allowed because a consumed/other marker remains.
    const freshG = evaluateMutationGate(
      mutationGateInputFromLoad(loaded, { currentSessionId: 'fresh' }),
    );
    assert.equal(freshG.deny, true);
    assert.ok(freshG.reasons.some((r) => r.startsWith('D3:invalid_record:denier')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureDenyMarker fails closed when sentinel write fails after marker', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-handoff-'));
  try {
    const realWrite = writeFileSync;
    const fs = {
      mkdirSync,
      renameSync,
      existsSync,
      readFileSync,
      unlinkSync() {},
      writeFileSync(path, data, enc) {
        const base = basename(String(path));
        // Unique tmp: `.deny-store.<pid>.<hex>.tmp` (or legacy `.deny-store`)
        if (base === '.deny-store' || (base.startsWith('.deny-store.') && base.endsWith('.tmp'))) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return realWrite(path, data, enc);
      },
    };
    const r = ensureDenyMarker(
      root,
      { sessionId: 's-sent', ticketId: 'T154', contentHash: 'h' },
      { fs },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'sentinel_write_failed');
    assert.equal(r.processSticky, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('overlapping ensureDenyMarker writes use distinct unique tmp paths', () => {
  const tmpWrites = [];
  const files = new Map();
  const dirs = new Set();
  const fs = {
    mkdirSync(path) {
      dirs.add(String(path));
    },
    existsSync(path) {
      const s = String(path);
      return files.has(s) || dirs.has(s);
    },
    writeFileSync(path, data) {
      const s = String(path);
      if (s.endsWith('.tmp')) tmpWrites.push(s);
      files.set(s, String(data));
    },
    renameSync(from, to) {
      const f = String(from);
      const t = String(to);
      assert.ok(files.has(f), `rename from missing tmp ${f}`);
      files.set(t, files.get(f));
      files.delete(f);
    },
    readFileSync(path) {
      const s = String(path);
      if (!files.has(s)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(s);
    },
    unlinkSync(path) {
      files.delete(String(path));
    },
  };

  const a = ensureDenyMarker('/root', { sessionId: 'sess-a', ticketId: 'T154', contentHash: 'h1' }, { fs });
  const b = ensureDenyMarker('/root', { sessionId: 'sess-b', ticketId: 'T154', contentHash: 'h2' }, { fs });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.ok(tmpWrites.length >= 4, `expected marker+sentinel tmps per call, got ${tmpWrites.length}`);
  const unique = new Set(tmpWrites);
  assert.equal(unique.size, tmpWrites.length, `tmp paths must be distinct: ${tmpWrites.join(',')}`);
  // Marker and sentinel temps share the pid+hex unique pattern (not fixed `.tmp`).
  for (const t of tmpWrites) {
    assert.match(t, /\.\d+\.[0-9a-f]{16}\.tmp$/);
  }
});