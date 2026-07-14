import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, LegacyTicketStore, TicketService, pendingTransactions, ticketFilename } from '../index.mjs';
import { ticket, writeDirectory, writeLegacy } from './helpers.mjs';

test('service plans are dry, hash-bound, intent-specific, and preserve unrelated shard bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-service-'));
  try {
    const path = writeDirectory(root, [ticket('A'), ticket('B')]);
    const store = new DirectoryTicketStore(path);
    const service = new TicketService(store, { root });
    const untouchedPath = join(path, ticketFilename('B'));
    const untouched = readFileSync(untouchedPath);
    const before = store.load();
    const plan = service.planUpdate('A', { ...before.get('A'), title: 'Changed' }, { expect: before.ticketHashes.A });
    assert.equal(store.load().get('A').title, 'Ticket A');
    const after = service.apply(plan);
    assert.equal(after.get('A').title, 'Changed');
    assert.deepEqual(readFileSync(untouchedPath), untouched);
    assert.throws(() => service.apply(plan), (error) => error.code === 'STALE_SNAPSHOT');
    const discard = service.planDiscard('B');
    assert.equal(discard.operation, 'discard');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('sensitive update, protected discard/completion, and reassignment require policy paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-policy-'));
  try {
    const path = writeDirectory(root, [ticket('A', { scope: ['a/**'], rails: ['test/**'] }), ticket('B', { edges: [{ to: 'A' }] })]);
    const store = new DirectoryTicketStore(path);
    const service = new TicketService(store, { root, protectedIds: ['A'] });
    const a = store.load().get('A');
    assert.throws(() => service.planUpdate('A', { ...a, scope: ['a/**', 'b/**'], rails: [] }), (error) => error.code === 'AUTHORIZATION_REQUIRED');
    assert.throws(() => service.planDiscard('A'), (error) => error.code === 'PROTECTED_TICKET');
    assert.throws(() => service.planComplete('A'), (error) => error.code === 'AUTHORIZATION_REQUIRED');
    assert.throws(() => service.planReassign('A', 'C'), (error) => error.code === 'AUTHORIZATION_REQUIRED');
    const plan = service.planReassign('A', 'C', { authorized: true });
    const after = service.apply(plan);
    assert.equal(after.get('B').edges[0].to, 'C');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('create, reassign, and reconciliation reject IDs already present in the archive', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-archive-collision-'));
  try {
    const path = writeDirectory(root, [ticket('ACTIVE')]);
    writeDirectory(root, [ticket('ARCHIVED')], { archive: true });
    const service = new TicketService(new DirectoryTicketStore(path), { root });
    assert.throws(() => service.planCreate(ticket('ARCHIVED')), (error) => error.code === 'ARCHIVE_COLLISION');
    assert.throws(() => service.planReassign('ACTIVE', 'ARCHIVED', { authorized: true }), (error) => error.code === 'ARCHIVE_COLLISION');
    assert.throws(
      () => service.planReconciliation([ticket('ARCHIVED')], { authorized: true }),
      (error) => error.code === 'ARCHIVE_COLLISION',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('legacy sensitive mutations are journaled and append mandatory evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-legacy-evidence-'));
  try {
    writeLegacy(root, [ticket('L')]);
    const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
    const service = new TicketService(store, { root });
    const after = service.apply(service.planComplete('L'));
    const [line] = readFileSync(join(root, '.adlc/manifest.jsonl'), 'utf8').trim().split('\n');
    const entry = JSON.parse(line);
    assert.equal(entry.ticket, 'L');
    assert.equal(entry.data.operation, 'complete');
    assert.equal(entry.data.ticketHash, after.ticketHashes.L);
    assert.equal(entry.data.storeHash, after.hash);
    assert.equal(existsSync(join(root, '.adlc/ticket-transactions')), true);
    assert.deepEqual(pendingTransactions(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('remote reconciliation appends manifest evidence only when it mutates an existing ticket in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-reconcile-evidence-'));
  const manifest = join(root, '.adlc/manifest.jsonl');
  try {
    writeLegacy(root, [ticket('A')]);
    const store = new LegacyTicketStore(join(root, '.adlc/tickets.json'));
    const service = new TicketService(store, { root });

    // Purely additive sync (A preserved byte-for-byte, B added) grants no
    // privilege — no untracked manifest.jsonl for rails-guard-ci to reject (T40).
    service.apply(service.planReconciliation([ticket('A'), ticket('B')], { authorized: true }));
    assert.equal(existsSync(manifest), false, 'additive reconciliation must not append manifest evidence');

    // Mutating an existing ticket IN PLACE is the privileged case → mandatory evidence.
    const before = store.load();
    const after = service.apply(service.planReconciliation(
      [{ ...before.get('A'), title: 'Changed in place' }, ticket('B')],
      { authorized: true },
    ));
    const lines = readFileSync(manifest, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one evidence entry for the in-place mutation');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.data.operation, 'remote-reconciliation');
    assert.equal(entry.data.storeHash, after.hash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an explicitly configured absolute legacy store remains writable during the 1.x bridge', () => {
  const parent = mkdtempSync(join(tmpdir(), 'adlc-tickets-external-legacy-'));
  const root = join(parent, 'repo');
  const external = join(parent, 'shared-tickets.json');
  try {
    mkdirSync(root);
    writeFileSync(external, `${JSON.stringify({ tickets: [ticket('A')] })}\n`);
    const store = new LegacyTicketStore(external);
    const service = new TicketService(store, { root });
    const after = service.apply(service.planComplete('A'));
    assert.equal(after.get('A').completed, true);
    assert.equal(JSON.parse(readFileSync(external, 'utf8')).tickets[0].completed, true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
