import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, resolveActiveTicket, verifyEvidenceBinding } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

test('active ticket pins ID and hash while ticket-scoped evidence survives unrelated additions', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-ticket-provenance-'));
  try {
    const path = writeDirectory(root, [ticket('A')]);
    const snapshot = new DirectoryTicketStore(path).load();
    writeFileSync(join(root, '.adlc/current-ticket.json'), JSON.stringify({ id: 'A', ticketHash: snapshot.ticketHashes.A }));
    const active = resolveActiveTicket(snapshot, { root, env: {} });
    const evidence = { ticket: 'A', ticketHash: active.ticketHash, storeHash: active.storeHash, bindingScope: 'ticket' };
    rmSync(path, { recursive: true });
    writeDirectory(root, [ticket('A'), ticket('B')]);
    const expanded = new DirectoryTicketStore(path).load();
    assert.equal(verifyEvidenceBinding(evidence, expanded), true);
    assert.throws(() => verifyEvidenceBinding({ ...evidence, bindingScope: 'store' }, expanded), (error) => error.code === 'STALE_STORE_EVIDENCE');
    rmSync(path, { recursive: true });
    writeDirectory(root, [ticket('A', { title: 'changed' }), ticket('B')]);
    const changed = new DirectoryTicketStore(path).load();
    assert.throws(() => resolveActiveTicket(changed, { root, env: {} }), (error) => error.code === 'ACTIVE_TICKET_STALE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
