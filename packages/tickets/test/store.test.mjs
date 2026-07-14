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
