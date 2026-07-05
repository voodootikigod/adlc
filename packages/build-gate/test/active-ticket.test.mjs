// test/active-ticket.test.mjs — resolve which ticket is "in flight" for the
// current build. Reuses the SAME convention every other ADLC harness
// integration already implements (plugins/adlc-codex/hooks/
// adlc-rails-guard.mjs resolveActiveTicketId(), plugins/adlc-antigravity/
// rails-checker.mjs resolveActiveTicketId()): ADLC_TICKET env var OR
// .adlc/current-ticket.json; a conflict between the two is a tamper signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveActiveTicketId } from '../lib/active-ticket.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'adlc-active-ticket-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no env var, no pointer file → id null, no conflict', () => {
  withTempDir((dir) => {
    const r = resolveActiveTicketId({ dir, env: {} });
    assert.deepEqual(r, { id: null, conflict: false });
  });
});

test('ADLC_TICKET env var alone resolves the id', () => {
  withTempDir((dir) => {
    const r = resolveActiveTicketId({ dir, env: { ADLC_TICKET: 'T9' } });
    assert.deepEqual(r, { id: 'T9', conflict: false });
  });
});

test('.adlc/current-ticket.json alone resolves the id ({ id })', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T3' }));
    const r = resolveActiveTicketId({ dir, env: {} });
    assert.deepEqual(r, { id: 'T3', conflict: false });
  });
});

test('.adlc/current-ticket.json with { ticket } shape also resolves', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ ticket: 'T4' }));
    const r = resolveActiveTicketId({ dir, env: {} });
    assert.deepEqual(r, { id: 'T4', conflict: false });
  });
});

test('env var and pointer file AGREE → resolves cleanly', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T9' }));
    const r = resolveActiveTicketId({ dir, env: { ADLC_TICKET: 'T9' } });
    assert.deepEqual(r, { id: 'T9', conflict: false });
  });
});

test('env var and pointer file DISAGREE → conflict, fail closed (id null)', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T2' }));
    const r = resolveActiveTicketId({ dir, env: { ADLC_TICKET: 'T9' } });
    assert.equal(r.conflict, true);
    assert.equal(r.id, null);
  });
});

test('unparseable pointer file → conflict (a tamper signal, not "no ticket")', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, '.adlc'));
    writeFileSync(join(dir, '.adlc', 'current-ticket.json'), 'not json');
    const r = resolveActiveTicketId({ dir, env: {} });
    assert.equal(r.conflict, true);
  });
});

test('empty ADLC_TICKET string is treated as unset', () => {
  withTempDir((dir) => {
    const r = resolveActiveTicketId({ dir, env: { ADLC_TICKET: '   ' } });
    assert.deepEqual(r, { id: null, conflict: false });
  });
});
