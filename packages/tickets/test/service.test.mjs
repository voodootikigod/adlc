import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirectoryTicketStore, LegacyTicketStore, TicketService, deepClone, pendingTransactions, ticketFilename } from '../index.mjs';
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
    // Ticket A declares a rail, so this store is a frozen trust root and every
    // mutation of it is an audited override that must be signable (see
    // bypass-audit.test.mjs). The key is incidental to what this test asserts.
    const service = new TicketService(store, { root, protectedIds: ['A'], key: 'test-manifest-key' });
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

test('#235 — planCreate rejects a rail that would freeze a manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-235-create-'));
  try {
    // Give the root a real manifest so discoverManifests has something to match.
    mkdirSync(join(root, 'packages', 'x'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', 'package.json'), '{"name":"x"}\n');
    const path = writeDirectory(root, [ticket('A')]);
    const service = new TicketService(new DirectoryTicketStore(path), { root });

    assert.throws(
      () => service.planCreate(ticket('NEW', { rails: ['packages/x/**'] })),
      (error) => error.code === 'RAIL_COVERS_MANIFEST' && /packages\/x\/lib/.test(error.message)
    );
    // The source-scoped form is accepted.
    const ok = service.planCreate(ticket('NEW', { rails: ['packages/x/lib/**'] }));
    assert.equal(ok.ticketId, 'NEW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#235 — planUpdate grandfathers an EXISTING manifest rail but rejects a NEW one', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-235-update-'));
  try {
    mkdirSync(join(root, 'packages', 'x'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', 'package.json'), '{"name":"x"}\n');
    mkdirSync(join(root, 'packages', 'y'), { recursive: true });
    writeFileSync(join(root, 'packages', 'y', 'package.json'), '{"name":"y"}\n');
    // A legacy ticket that ALREADY declares a manifest-covering rail.
    const path = writeDirectory(root, [ticket('A', { rails: ['packages/x/**'] })]);
    const service = new TicketService(new DirectoryTicketStore(path), { root });
    const a = service.snapshot().get('A');

    // An ordinary edit that keeps the existing rail must still work — the whole
    // point of grandfathering. (rail-narrowing/none here, so no authorization.)
    const ok = service.planUpdate('A', { ...a, title: 'Edited' },
      { expect: service.snapshot().ticketHashes.A });
    assert.equal(ok.ticketId, 'A');

    // ADDING a second manifest-covering rail is rejected. authorized:true so this
    // is not deflected by the scope/rail authorization path — the manifest check
    // is independent of it.
    assert.throws(
      () => service.planUpdate('A', { ...a, rails: ['packages/x/**', 'packages/y/**'] },
        { expect: service.snapshot().ticketHashes.A, authorized: true }),
      (error) => error.code === 'RAIL_COVERS_MANIFEST' && /packages\/y/.test(error.message)
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#235 — completing a legacy ticket with a manifest rail is unaffected', () => {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-235-complete-'));
  try {
    mkdirSync(join(root, 'packages', 'x'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', 'package.json'), '{"name":"x"}\n');
    const path = writeDirectory(root, [ticket('A', { rails: ['packages/x/**'] })]);
    // A rail is declared, so the store is a frozen trust root — signable, as above.
    const service = new TicketService(new DirectoryTicketStore(path), { root, key: 'test-manifest-key' });
    // planComplete routes through its own path, not planUpdate, so the manifest
    // check never sees it — a shipped ticket can always be closed out.
    const plan = service.planComplete('A', { authorized: true });
    const after = service.apply(plan);
    assert.equal(after.get('A').completed, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A service over a scratch directory store, with cleanup. */
function withService(tickets, fn) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-tickets-lifecycle-'));
  try {
    const service = new TicketService(new DirectoryTicketStore(writeDirectory(root, tickets)), { root });
    return fn(service);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('update treats a lifecycle change as sensitive, so it carries evidence', () => {
  // planComplete records `completed` as an evidence-bearing lifecycle change.
  // Generic update replaces the WHOLE ticket, so setting that field through it
  // slipped past the lifecycle path entirely: a scheduler then skips unfinished
  // work with no completion record in the manifest. This reuses the existing
  // sensitivity mechanism rather than inventing a second one — rail-narrowing
  // and scope-widening already work exactly this way.
  withService([ticket('T1')], (service) => {
    const hash = service.snapshot().ticketHashes.T1;
    assert.throws(
      () => service.planUpdate('T1', { ...ticket('T1'), completed: true }, { expect: hash }),
      (error) => error.code === 'AUTHORIZATION_REQUIRED' && /lifecycle-change/.test(error.message),
      'setting completed through update must require authorization',
    );
    const authorized = service.planUpdate('T1', { ...ticket('T1'), completed: true }, { expect: hash, authorized: true });
    assert.ok(authorized.sensitive.includes('lifecycle-change'));
    assert.equal(authorized.evidenceRequired, true, 'and must be evidence-bearing');
  });
});

test('clearing or dropping completed is the same lifecycle change', () => {
  // Reopening finished work, and silently losing the flag by omitting it from a
  // replacement document, are the same transition in the other direction. The
  // omission case is the one an author hits by accident.
  withService([ticket('T1', { completed: true })], (service) => {
    const hash = service.snapshot().ticketHashes.T1;
    for (const input of [{ ...ticket('T1'), completed: false }, ticket('T1')]) {
      assert.throws(
        () => service.planUpdate('T1', input, { expect: hash }),
        (error) => error.code === 'AUTHORIZATION_REQUIRED' && /lifecycle-change/.test(error.message),
      );
    }
  });
});

test('an update that leaves completed alone stays unsensitive', () => {
  // The guard must not tax ordinary edits: a title change on a completed ticket
  // carries the flag through untouched and needs no authorization.
  withService([ticket('T1', { completed: true })], (service) => {
    const hash = service.snapshot().ticketHashes.T1;
    const plan = service.planUpdate('T1', { ...ticket('T1'), completed: true, title: 'renamed' }, { expect: hash });
    assert.deepEqual(plan.sensitive, []);
  });
});

test('lifecycle detection matches how consumers actually read the flag', () => {
  // Every downstream reader uses `completed === true` — coldstart, fleet,
  // merge-forecast, model-router, ticket-prune. A Boolean() comparison here
  // therefore missed a real transition: `"completed":"false"` is truthy, so
  // Boolean() saw no change, while every scheduler saw the ticket become
  // UNCOMPLETED and queued finished work again, with no lifecycle evidence.
  const truthyNotTrue = ['false', 'no', 0, 1, {}, [], 'true'];
  withService([ticket('T1', { completed: true })], (service) => {
    const hash = service.snapshot().ticketHashes.T1;
    for (const value of truthyNotTrue) {
      assert.throws(
        () => service.planUpdate('T1', { ...ticket('T1'), completed: value }, { expect: hash }),
        (error) => error.code === 'AUTHORIZATION_REQUIRED' && /lifecycle-change/.test(error.message),
        `completed: ${JSON.stringify(value)} must count as leaving the completed state`,
      );
    }
  });
});

test('absent and false are the same non-completed state, not a transition', () => {
  withService([ticket('T1')], (service) => {
    const hash = service.snapshot().ticketHashes.T1;
    const plan = service.planUpdate('T1', { ...ticket('T1'), completed: false }, { expect: hash });
    assert.deepEqual(plan.sensitive, [], 'absent -> false is not a lifecycle change');
  });
});

test('deepClone refuses values JSON cannot round-trip', () => {
  // The declaration says `<T extends JsonValue>(value: T): T`, so a consumer
  // cloning numeric data keeps the `number` type. JSON turns NaN and the
  // infinities into null, so that promise was still false for them and a
  // following `.toFixed()` compiled and threw. Fail closed at the boundary
  // instead, which makes the declared contract true for everything that returns.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => deepClone({ value: bad }), /non-finite/i, `deepClone must reject ${bad}`);
    assert.throws(() => deepClone([bad]), /non-finite/i);
    assert.throws(() => deepClone(bad), /non-finite/i);
  }
});

test('deepClone still clones ordinary JSON data unchanged', () => {
  // NB: no -0 here. JSON serializes it as 0, but TypeScript has no -0 type, so
  // that round-trip does not violate the declaration the way NaN -> null does.
  const source = { a: 1, b: [2, 3.5, 0], c: { d: 'x', e: null, f: true } };
  const clone = deepClone(source);
  assert.deepEqual(clone, source);
  assert.notEqual(clone, source, 'it must be a copy, not the same reference');
  assert.notEqual(clone.c, source.c, 'and a deep one');
});

test('deepClone refuses array positions JSON turns into null', () => {
  // A sparse or undefined-bearing array survives JSON as [null], so a consumer
  // holding a `number[]` got null and threw on the first numeric method — the
  // declared type was still number[]. Object properties are deliberately NOT
  // covered: JSON drops an undefined property, and dropping an OPTIONAL
  // property is type-compatible.
  assert.throws(() => deepClone(new Array(1)), /array index/, 'a hole must be rejected');
  assert.throws(() => deepClone([1, undefined, 3]), /array index/);
  assert.throws(() => deepClone([() => {}]), /array index/);
  assert.throws(() => deepClone([Symbol('x')]), /array index/);
  assert.deepEqual(deepClone({ optional: undefined, kept: 1 }), { kept: 1 }, 'a dropped optional property is fine');
});

test('deepClone refuses arrays carrying non-index properties', () => {
  // JSON serializes only an array's INDEX properties, so this value loses
  // `meta` while keeping its declared type — the clone type-checks and the
  // property is simply gone at runtime.
  const tagged = Object.assign([1, 2], { meta: 'kept' });
  assert.throws(() => deepClone(tagged), /non-index array/);
  assert.deepEqual(deepClone([1, 2]), [1, 2], 'a plain array is unaffected');
  assert.deepEqual(deepClone({ list: [1, 2] }), { list: [1, 2] }, 'and so is a nested one');
});

test('deepClone rejects numeric-looking keys JSON does not treat as indices', () => {
  // "01" and "4294967295" pass a naive /^\d+$/ index test but are NOT canonical
  // array indices, so JSON.stringify drops them. Symbol keys are dropped too and
  // Object.keys cannot even see them.
  for (const key of ['01', '4294967295', '1e2', ' 1']) {
    const tagged = Object.assign([1, 2], { [key]: 'metadata' });
    assert.throws(() => deepClone(tagged), /non-index array key/, `key ${JSON.stringify(key)} must be rejected`);
  }
  const symbolTagged = Object.assign([1, 2], { [Symbol('meta')]: 'x' });
  assert.throws(() => deepClone(symbolTagged), /non-index array key/, 'a symbol key must be rejected');
  // Canonical indices are of course fine.
  assert.deepEqual(deepClone(Object.assign([], { 0: 'a', 1: 'b' })), ['a', 'b']);
});
