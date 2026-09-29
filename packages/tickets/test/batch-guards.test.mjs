// planCreateBatch runs the same per-ticket guards as planCreate, never
// half-applies, and records one store-scoped evidence entry for the batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, TicketService } from '../index.mjs';
import { ticket, writeDirectory } from './helpers.mjs';

function withRoot(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('planCreateBatch rejects an id already in the archive and writes nothing', () => {
  withRoot('adlc-batch-archive-', (root) => {
    const path = writeDirectory(root, [ticket('A')]);
    writeDirectory(root, [ticket('GONE')], { archive: true });
    const store = new DirectoryTicketStore(path);
    const service = new TicketService(store, { root });
    const before = store.load().hash;
    assert.throws(() => service.planCreateBatch([ticket('NEW'), ticket('GONE')]),
      (e) => e.code === 'ARCHIVE_COLLISION' && /\bGONE\b/.test(e.message));
    assert.equal(store.load().hash, before);
    assert.ok(service.apply(service.planCreateBatch([ticket('NEW')])).get('NEW'), 'a non-archived id still lands');
  });
});

test('planCreateBatch rejects a rail that freezes a package manifest', () => {
  withRoot('adlc-batch-rails-', (root) => {
    mkdirSync(join(root, 'packages', 'x'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', 'package.json'), '{"name":"x"}\n');
    const path = writeDirectory(root, []);
    const service = new TicketService(new DirectoryTicketStore(path), { root });
    assert.throws(() => service.planCreateBatch([ticket('OK'), ticket('BAD', { rails: ['packages/x/**'] })]),
      (e) => e.code === 'RAIL_COVERS_MANIFEST' && /packages\/x/.test(e.message));
    const plan = service.planCreateBatch([ticket('OK'), ticket('SRC', { rails: ['packages/x/lib/**'] })]);
    assert.equal(plan.operation, 'batch-create', 'a source-scoped rail is accepted');
  });
});

test('applying a batch planned against a stale snapshot fails and leaves the store unchanged', () => {
  withRoot('adlc-batch-stale-', (root) => {
    const path = writeDirectory(root, [ticket('A')]);
    const store = new DirectoryTicketStore(path);
    const service = new TicketService(store, { root });
    const batch = service.planCreateBatch([ticket('P'), ticket('Q')]);
    service.apply(service.planCreate(ticket('OTHER')));
    const between = store.load().hash;
    assert.throws(() => service.apply(batch), (e) => e.code === 'STALE_SNAPSHOT');
    const after = store.load();
    assert.equal(after.hash, between);
    assert.equal(after.get('P'), undefined);
    assert.equal(after.get('Q'), undefined);
  });
});

test('a batch on a railed store records one store-scoped batch-create entry', () => {
  withRoot('adlc-batch-evidence-', (root) => {
    const path = writeDirectory(root, [ticket('A', { rails: ['test/**'] })]);
    const service = new TicketService(new DirectoryTicketStore(path), { root, key: 'a'.repeat(64) });
    const after = service.apply(service.planCreateBatch([ticket('P'), ticket('Q')]));
    const entries = readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(entries.length, 1);
    const [{ gate, data }] = entries;
    assert.equal(gate, 'ticket-mutation');
    assert.equal(data.operation, 'batch-create');
    assert.equal(data.ticketId, null);
    assert.equal(data.bindingScope, 'store');
    assert.equal(data.storeHashAfter, after.hash);
    assert.equal('ticketIds' in data, false);
  });
});
