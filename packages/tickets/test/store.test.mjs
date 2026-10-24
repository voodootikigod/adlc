import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectTicketStore } from '../index.mjs';
import { ticket, writeDirectory, writeLegacy } from './helpers.mjs';

test('detection allows exactly one backend and conflicting overrides fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-detect-'));
  try {
    writeLegacy(root, [ticket('A')]);
    assert.equal(detectTicketStore({ root }).load().backend, 'legacy');
    writeDirectory(root, [ticket('A')]);
    assert.throws(() => detectTicketStore({ root }), (error) => error.code === 'AMBIGUOUS_STORE');
    assert.throws(() => detectTicketStore({ root, ticketStore: '.adlc/tickets', legacyTickets: '.adlc/other.json' }), (error) => error.code === 'CONFLICTING_STORE_OVERRIDE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('ticket-store validation errors end once per batch with a pointer to schema and doctor (#892)', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-pointer-892-'));
  try {
    writeLegacy(root, [
      { ...ticket('T1'), duration: 'M' },
      { ...ticket('T2'), edges: [{}] },
    ]);
    assert.throws(
      () => detectTicketStore({ root }).load(),
      (error) => {
        assert.equal(error.code, 'INVALID_TICKET_STORE');
        assert.match(error.message, /^ticket store validation failed \(2 error\(s\)\):/);
        assert.match(error.message, /T1: duration must be a positive number/);
        assert.match(error.message, /T2: edge missing string "to"/);
        assert.match(error.message, /see `adlc ticket schema` and `adlc ticket doctor`$/);
        assert.equal(error.details.length, 3);
        assert.equal(error.details.at(-1), 'see `adlc ticket schema` and `adlc ticket doctor`');
        assert.equal(error.details.filter((line) => line.includes('adlc ticket schema')).length, 1);
        return true;
      },
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});
