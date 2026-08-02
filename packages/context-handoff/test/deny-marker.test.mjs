import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureDenyMarker,
  readDenyMarker,
  evaluateMarkerOnReentry,
  denyPath,
} from '../lib/deny-marker.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

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
