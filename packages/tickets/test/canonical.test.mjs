import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, generateTicketId, isGeneratedTicketId, storeHash, ticketFilename, ticketHash } from '../index.mjs';
import { ticket } from './helpers.mjs';

test('canonical objects ignore key order while arrays preserve order', () => {
  assert.equal(canonicalJson({ b: 2, a: [1, 2] }), canonicalJson({ a: [1, 2], b: 2 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

test('ticket and store hashes are domain separated and store order is non-semantic', () => {
  const a = ticket('A');
  const b = ticket('B');
  assert.notEqual(ticketHash(a), storeHash([a]));
  assert.equal(storeHash([a, b]), storeHash([b, a]));
  assert.notEqual(ticketHash(a), ticketHash({ ...a, rails: ['x'] }));
});

test('ULID IDs are collision-resistant and filenames bind the exact Unicode ID', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => generateTicketId()));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.equal(isGeneratedTicketId(id), true);
  assert.match(ticketFilename('Å Ticket/一'), /^a-ticket--[a-f0-9]{64}\.json$/);
  assert.notEqual(ticketFilename('A'), ticketFilename('a'));
});
