// The active-ticket pointer contract (.adlc/current-ticket.json).
//
// This file is a RAIL: it is the executable definition of the pointer contract
// and the anti-drift mechanism for the nine readers that used to hand-copy their
// own resolver. Every reader -- the domain module, the copy generated into each
// harness, and @adlc/build-gate's adapter -- is run over ONE shared vector table
// and must reach the SAME decision on every vector. A reader that disagrees is
// exactly the bug this rail exists to catch.
//
// The defect this contract closes: an object pointer whose id key was not
// recognized used to resolve to "no active ticket" => ALLOW. A trust root must
// never fail open on a shape it does not understand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readActiveTicketPointer, resolveActiveTicketAgainst } from '../lib/pointer.mjs';
import { writeActiveTicket } from '../lib/pointer-write.mjs';
import { resolveActiveTicket } from '../lib/provenance.mjs';
import { LegacyTicketStore } from '../lib/stores/legacy.mjs';

// import.meta.dirname is only available in Node >= 20.11; derive it so the
// suite runs on the package's declared floor (engines.node >=18).
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every generated harness copy of the pointer module. Byte-identical by contract. */
const GENERATED_READERS = [
  'plugins/adlc-codex/hooks/generated-active-ticket.mjs',
  'plugins/adlc-claude-code/hooks/generated-active-ticket.mjs',
  'plugins/adlc-antigravity/generated-active-ticket.mjs',
  'plugins/adlc-opencode/generated-active-ticket.mjs',
  'plugins/adlc-cursor/generated-active-ticket.mjs',
  'plugins/adlc-pi/lib/generated-active-ticket.mjs',
  'plugins/adlc-copilot/hooks/generated-active-ticket.mjs',
  'plugins/adlc-herdr/lib/generated-active-ticket.mjs',
];

const TICKET = { id: 'T1', title: 'Pointer fixture', rails: ['test/**'] };
const OTHER = { id: 'T2', title: 'Other fixture' };

/** Build a repo fixture; `build` receives the snapshot and returns the pointer value. */
function fixture(build, { raw = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adlc-pointer-'));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc/tickets.json'), JSON.stringify({ tickets: [TICKET, OTHER] }));
  const snapshot = new LegacyTicketStore(join(root, '.adlc/tickets.json')).load();
  if (build) {
    const value = build(snapshot);
    if (value !== undefined) {
      writeFileSync(join(root, '.adlc/current-ticket.json'), raw ? value : JSON.stringify(value));
    }
  }
  return { root, snapshot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const hashOf = (snapshot, id) => snapshot.ticketHashes[id];

async function allReaders() {
  const readers = [{ name: 'packages/tickets/lib/pointer.mjs', fn: resolveActiveTicketAgainst }];
  for (const relative of GENERATED_READERS) {
    const mod = await import(pathToFileURL(join(REPO, relative)).href);
    readers.push({ name: relative, fn: mod.resolveActiveTicketAgainst });
  }
  return readers;
}

// ---------------------------------------------------------------------------
// The shared vector table: the pointer file, the env, and the ONE decision every
// reader must reach.
//
//   'resolve' -> ok, value.id === id
//   'inert'   -> ok, value === null (the only allow-with-no-ticket; needs no file)
//   'deny'    -> !ok, code === code
// ---------------------------------------------------------------------------

const VECTORS = [
  {
    name: 'canonical {id, ticketHash} resolves',
    pointer: (s) => ({ id: 'T1', ticketHash: hashOf(s, 'T1') }),
    expect: { outcome: 'resolve', id: 'T1' },
  },
  {
    name: 'deprecated alias ticketId resolves and is flagged',
    pointer: (s) => ({ ticketId: 'T1', ticketHash: hashOf(s, 'T1') }),
    expect: { outcome: 'resolve', id: 'T1', deprecatedAlias: 'ticketId' },
  },
  {
    name: 'deprecated alias ticket resolves and is flagged',
    pointer: (s) => ({ ticket: 'T1', ticketHash: hashOf(s, 'T1') }),
    expect: { outcome: 'resolve', id: 'T1', deprecatedAlias: 'ticket' },
  },
  {
    // THE FAIL-OPEN HOLE. Every reader used to answer "no active ticket" here
    // and ALLOW the build.
    name: 'unrecognized id key denies (fail-closed, not fail-open)',
    pointer: () => ({ tickett: 'T1', ticketHash: 'whatever' }),
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    // PRECEDENCE. Canonical `id` wins over any alias, and every reader must agree
    // on that -- two readers picking different keys out of the SAME pointer is the
    // original defect wearing a different hat. Without this vector, inverting the
    // key order in one generated copy diverges the readers with a green suite.
    name: 'canonical id wins over a deprecated alias in every reader',
    pointer: (s) => ({ id: 'T1', ticketId: 'T2', ticket: 'T2', ticketHash: hashOf(s, 'T1') }),
    expect: { outcome: 'resolve', id: 'T1' },
  },
  {
    name: 'alias precedence is fixed: ticket wins over ticketId',
    pointer: (s) => ({ ticket: 'T1', ticketId: 'T2', ticketHash: hashOf(s, 'T1') }),
    expect: { outcome: 'resolve', id: 'T1', deprecatedAlias: 'ticket' },
  },
  {
    name: 'object with a hash but no id denies',
    pointer: () => ({ ticketHash: 'orphaned' }),
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'empty object denies (deactivation is deleting the file)',
    pointer: () => ({}),
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'unparseable pointer denies',
    pointer: () => 'not json at all',
    raw: true,
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'non-string id denies',
    pointer: () => ({ id: 42 }),
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'blank id denies',
    pointer: () => ({ id: '   ' }),
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'JSON array denies',
    pointer: () => ['T1'],
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'JSON null denies',
    pointer: () => null,
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'absent pointer with no env is inert',
    pointer: null,
    expect: { outcome: 'inert' },
  },
  {
    name: 'env alone resolves with no pointer file',
    pointer: null,
    env: { ADLC_TICKET: 'T1' },
    expect: { outcome: 'resolve', id: 'T1' },
  },
  {
    name: 'env agreeing with the pointer resolves',
    pointer: (s) => ({ id: 'T1', ticketHash: hashOf(s, 'T1') }),
    env: { ADLC_TICKET: 'T1' },
    expect: { outcome: 'resolve', id: 'T1' },
  },
  {
    name: 'env disagreeing with the pointer denies',
    pointer: (s) => ({ id: 'T2', ticketHash: hashOf(s, 'T2') }),
    env: { ADLC_TICKET: 'T1' },
    expect: { outcome: 'deny', code: 'ACTIVE_TICKET_CONFLICT' },
  },
  {
    name: 'env disagreeing with an alias pointer still denies',
    pointer: (s) => ({ ticketId: 'T2', ticketHash: hashOf(s, 'T2') }),
    env: { ADLC_TICKET: 'T1' },
    expect: { outcome: 'deny', code: 'ACTIVE_TICKET_CONFLICT' },
  },
  {
    name: 'a malformed pointer denies even when env names a valid ticket',
    pointer: () => ({ tickett: 'T2' }),
    env: { ADLC_TICKET: 'T1' },
    expect: { outcome: 'deny', code: 'INVALID_CURRENT_TICKET' },
  },
  {
    name: 'stale ticketHash denies',
    pointer: () => ({ id: 'T1', ticketHash: 'f'.repeat(64) }),
    expect: { outcome: 'deny', code: 'ACTIVE_TICKET_STALE' },
  },
  {
    name: 'ticket absent from the store denies',
    pointer: () => ({ id: 'T-NOPE', ticketHash: 'f'.repeat(64) }),
    expect: { outcome: 'deny', code: 'ACTIVE_TICKET_MISSING' },
  },
  {
    name: 'env naming a ticket absent from the store denies',
    pointer: null,
    env: { ADLC_TICKET: 'T-NOPE' },
    expect: { outcome: 'deny', code: 'ACTIVE_TICKET_MISSING' },
  },
];

/** Vectors whose decision depends on the documented 1.x bridge flag. */
const BRIDGE_VECTORS = [
  {
    name: 'missing ticketHash',
    pointer: () => ({ id: 'T1' }),
    strict: { outcome: 'deny', code: 'ACTIVE_TICKET_HASH_MISSING' },
    bridged: { outcome: 'resolve', id: 'T1', warned: true },
  },
  {
    name: 'legacy bare-string pointer',
    // Written raw so the file holds a bare JSON string ("T1"), not an object.
    pointer: () => '"T1"',
    raw: true,
    strict: { outcome: 'deny', code: 'ACTIVE_TICKET_HASH_MISSING' },
    bridged: { outcome: 'resolve', id: 'T1', warned: true },
  },
];

/**
 * Outcomes that only a reader holding a ticket store can reach.
 *
 * @adlc/build-gate's resolveActiveTicketId({dir, env}) resolves IDENTITY: it takes
 * no snapshot (its bin loads the store separately), so it cannot decide whether a
 * ticket exists or whether a pinned hash is stale. That boundary is deliberate,
 * and it is not the fail-open hole -- for these vectors build-gate must still
 * resolve the id and let the store-holding layer deny. What it may never do is
 * report "no active ticket", which is what silently disabled enforcement.
 */
const SNAPSHOT_DEPENDENT = new Set(['ACTIVE_TICKET_MISSING', 'ACTIVE_TICKET_STALE', 'ACTIVE_TICKET_HASH_MISSING']);

function assertOutcome(result, expect, label) {
  if (expect.outcome === 'deny') {
    assert.equal(result.ok, false, `${label}: expected deny, got ${JSON.stringify(result)}`);
    assert.equal(result.code, expect.code, `${label}: wrong deny code`);
    return;
  }
  assert.equal(result.ok, true, `${label}: expected ok, got ${JSON.stringify(result)}`);
  if (expect.outcome === 'inert') {
    assert.equal(result.value, null, `${label}: expected inert`);
    return;
  }
  assert.equal(result.value?.id, expect.id, `${label}: wrong resolved id`);
  if (expect.deprecatedAlias) {
    assert.equal(result.value.deprecatedAlias, expect.deprecatedAlias, `${label}: alias not flagged`);
  }
  if (expect.warned) {
    assert.ok((result.value.warnings ?? []).length > 0, `${label}: expected a bridge warning`);
  }
}

function runVector(fn, vector, allowLegacyPointer = false) {
  const f = fixture(vector.pointer, { raw: vector.raw });
  try {
    return fn(f.snapshot, { root: f.root, env: vector.env ?? {}, allowLegacyPointer });
  } finally { f.cleanup(); }
}

// ---------------------------------------------------------------------------
// AC2 -- reader agreement. The rail's core assertion.
// ---------------------------------------------------------------------------

test('reader agreement: every reader reaches the same decision on every vector', async () => {
  const readers = await allReaders();
  assert.equal(readers.length, GENERATED_READERS.length + 1, 'a reader is missing from the agreement set');
  for (const vector of VECTORS) {
    for (const reader of readers) {
      assertOutcome(runVector(reader.fn, vector), vector.expect, `${reader.name} :: ${vector.name}`);
    }
  }
});

test('reader agreement: bridge vectors agree across every reader in both modes', async () => {
  const readers = await allReaders();
  for (const vector of BRIDGE_VECTORS) {
    for (const reader of readers) {
      assertOutcome(runVector(reader.fn, vector, false), vector.strict, `${reader.name} :: ${vector.name} (strict)`);
      assertOutcome(runVector(reader.fn, vector, true), vector.bridged, `${reader.name} :: ${vector.name} (bridged)`);
    }
  }
});

/**
 * Every adapter that reduces the canonical result to the {id, conflict} shape.
 *
 * All four are in the set because a hollow-test mutation proved they needed to be:
 * flipping `conflict: true` -> `conflict: false` on antigravity's deny path
 * SURVIVED the whole suite. That mutation IS the bug this ticket exists to kill --
 * a harness reporting "nothing wrong here" for a pointer it cannot understand --
 * so every adapter's deny path is now pinned, not just build-gate's.
 */
const CONFLICT_ADAPTERS = [
  { name: '@adlc/build-gate', path: 'packages/build-gate/lib/active-ticket.mjs', call: (fn, root, env) => fn({ dir: root, env }) },
  { name: 'adlc-antigravity', path: 'plugins/adlc-antigravity/rails-checker.mjs', call: (fn, root, env) => fn(root, env) },
  { name: 'adlc-cursor', path: 'plugins/adlc-cursor/rails-checker.mjs', call: (fn, root, env) => fn(root, env) },
  { name: 'adlc-opencode', path: 'plugins/adlc-opencode/rails-checker.mjs', call: (fn, root, env) => fn(root, env) },
];

test('reader agreement: every {id, conflict} adapter agrees on id and on fail-closed', async () => {
  const adapters = [];
  for (const adapter of CONFLICT_ADAPTERS) {
    const mod = await import(pathToFileURL(join(REPO, adapter.path)).href);
    adapters.push({ ...adapter, fn: mod.resolveActiveTicketId });
  }
  for (const vector of VECTORS) {
    for (const adapter of adapters) {
      const f = fixture(vector.pointer, { raw: vector.raw });
      try {
        const got = adapter.call(adapter.fn, f.root, vector.env ?? {});
        const label = `${adapter.name} :: ${vector.name}`;
        if (SNAPSHOT_DEPENDENT.has(vector.expect.code)) {
          assert.equal(got.conflict, false, label);
          assert.ok(typeof got.id === 'string' && got.id.length > 0, `${label}: identity must still resolve, not vanish`);
          continue;
        }
        if (vector.expect.outcome === 'deny') {
          assert.equal(got.conflict, true, `${label}: expected fail-closed, got ${JSON.stringify(got)}`);
          assert.equal(got.id, null, `${label}: a denied result must carry no id`);
          // The WHY must survive the reduction to {id, conflict}. Without this, the
          // canonical diagnosis was computed and dropped, and every harness told the
          // operator "ADLC_TICKET conflicts with the pointer" — even with no
          // ADLC_TICKET set and a typo'd key as the real cause.
          assert.equal(got.code, vector.expect.code, `${label}: denial must carry the canonical code`);
          assert.ok(got.message && got.message.length > 0, `${label}: denial must carry the canonical message`);
        } else if (vector.expect.outcome === 'inert') {
          assert.equal(got.id, null, label);
          assert.equal(got.conflict, false, label);
        } else {
          assert.equal(got.conflict, false, `${label}: unexpected fail-closed`);
          assert.equal(got.id, vector.expect.id, `${label}: wrong id`);
        }
      } finally { f.cleanup(); }
    }
  }
});

test('reader agreement: the generated reader works with the GENERATED loader snapshot', async () => {
  // The vectors above hand the DOMAIN's snapshot to every reader, which proves the
  // readers agree but NOT that a harness can actually run one: a harness loads its
  // store through the generated read-only loader, whose snapshot is a different
  // object. That gap hid a real drift -- the generated snapshot had no get(id),
  // so every generated pointer reader crashed on a harness's own snapshot while
  // this suite stayed green. Substitutability is the contract; assert it directly.
  const { loadTicketStoreReadOnly } = await import(
    pathToFileURL(join(REPO, 'scripts/ticket-readers/read-only-loader.mjs')).href
  );
  for (const relative of GENERATED_READERS) {
    const mod = await import(pathToFileURL(join(REPO, relative)).href);
    const f = fixture(null);
    try {
      const loaderSnapshot = loadTicketStoreReadOnly({ root: f.root, env: {} });
      assert.equal(typeof loaderSnapshot.get, 'function', `${relative}: generated snapshot must implement get(id) (spec §8.1)`);
      writeActiveTicket(f.root, { id: 'T1', ticketHash: loaderSnapshot.ticketHashes.T1 });

      const resolved = mod.resolveActiveTicketAgainst(loaderSnapshot, { root: f.root, env: {} });
      assert.equal(resolved.ok, true, `${relative}: ${JSON.stringify(resolved)}`);
      assert.equal(resolved.value.id, 'T1');

      // And the hole stays closed against a real harness snapshot.
      writeFileSync(join(f.root, '.adlc/current-ticket.json'), JSON.stringify({ tickett: 'T1' }));
      const denied = mod.resolveActiveTicketAgainst(loaderSnapshot, { root: f.root, env: {} });
      assert.equal(denied.ok, false, `${relative}: unrecognized key must deny`);
      assert.equal(denied.code, 'INVALID_CURRENT_TICKET');
    } finally { f.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// AC3 -- the live bug that motivated this contract.
// ---------------------------------------------------------------------------

test('live pointer regression: the repo pointer shape that silently disabled enforcement', () => {
  // The exact shape found in this repo's own .adlc/current-ticket.json. Seven of
  // nine readers -- including the canonical one -- answered {id:null} => allow.
  const f = fixture((s) => ({ ticketId: 'T1', ticketHash: hashOf(s, 'T1') }));
  try {
    const result = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.value.id, 'T1', 'the live pointer must resolve, not vanish');
    assert.equal(result.value.deprecatedAlias, 'ticketId');
  } finally { f.cleanup(); }
});

test('live pointer regression: no object pointer ever resolves to a silent allow', () => {
  // The invariant, stated directly: if the file exists and parses to an object,
  // the outcome is resolve or deny -- never inert. Inert requires no file.
  const shapes = [{ tickett: 'T1' }, { ticketID: 'T1' }, { Id: 'T1' }, { id: '' }, {}, { ticketHash: 'x' }];
  for (const shape of shapes) {
    const f = fixture(() => shape);
    try {
      const result = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: {} });
      const inert = result.ok && result.value === null;
      assert.equal(inert, false, `pointer ${JSON.stringify(shape)} resolved to a silent allow`);
    } finally { f.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// AC4 -- hash strictness.
// ---------------------------------------------------------------------------

test('hash: a present ticketHash is verified in every mode, bridge or not', () => {
  for (const allowLegacyPointer of [false, true]) {
    const f = fixture(() => ({ id: 'T1', ticketHash: 'f'.repeat(64) }));
    try {
      const result = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: {}, allowLegacyPointer });
      assert.equal(result.ok, false, `bridge=${allowLegacyPointer} must not skip a present hash`);
      assert.equal(result.code, 'ACTIVE_TICKET_STALE');
    } finally { f.cleanup(); }
  }
});

test('hash: a missing hash denies under strict and warns under the 1.x bridge', () => {
  const f = fixture(() => ({ id: 'T1' }));
  try {
    const strict = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: {}, allowLegacyPointer: false });
    assert.equal(strict.ok, false);
    assert.equal(strict.code, 'ACTIVE_TICKET_HASH_MISSING');

    const bridged = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: {}, allowLegacyPointer: true });
    assert.equal(bridged.ok, true);
    assert.equal(bridged.value.id, 'T1');
    assert.ok(bridged.value.warnings.some((w) => /ticketHash/.test(w)), 'the bridge must warn about the missing hash');
  } finally { f.cleanup(); }
});

test('hash: env-only resolution has no pointer hash to verify', () => {
  const f = fixture(null);
  try {
    const result = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: { ADLC_TICKET: 'T1' } });
    assert.equal(result.ok, true);
    assert.equal(result.value.id, 'T1');
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// AC7 -- the conflict error names the model.
// ---------------------------------------------------------------------------

test('conflict message names the per-worktree model and the remedy', () => {
  const f = fixture((s) => ({ id: 'T2', ticketHash: hashOf(s, 'T2') }));
  try {
    const result = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: { ADLC_TICKET: 'T1' } });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ACTIVE_TICKET_CONFLICT');
    assert.match(result.message, /worktree/i, 'the conflict must name the per-worktree model');
    assert.match(result.message, /git worktree add/, 'the conflict must name the remedy');
    assert.match(result.message, /T1/);
    assert.match(result.message, /T2/);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// AC6 -- atomic writes.
// ---------------------------------------------------------------------------

test('atomic: writeActiveTicket emits exactly the canonical shape', () => {
  const f = fixture(null);
  try {
    writeActiveTicket(f.root, { id: 'T1', ticketHash: hashOf(f.snapshot, 'T1') });
    const written = JSON.parse(readFileSync(join(f.root, '.adlc/current-ticket.json'), 'utf8'));
    assert.deepEqual(Object.keys(written).sort(), ['id', 'ticketHash']);
    assert.equal(written.id, 'T1');
    const result = resolveActiveTicketAgainst(f.snapshot, { root: f.root, env: {} });
    assert.equal(result.ok, true, 'a pointer we wrote must satisfy our own STRICT reader');
    assert.equal(result.value.deprecatedAlias, undefined, 'we must never write a deprecated alias');
  } finally { f.cleanup(); }
});

test('atomic: the pointer is replaced by rename, never written in place', () => {
  // Atomicity here is NOT observable by racing, and pretending otherwise produces
  // a hollow test. Two earlier versions of this test proved that:
  //   1. A sequential write-then-read never interleaves, so it passed against a
  //      plain writeFileSync -- the exact defect it claimed to guard.
  //   2. A real two-process race ALSO passed against it: the payload is ~100
  //      bytes, so the O_TRUNC window between truncate and write is nanoseconds
  //      wide and a reader essentially never lands in it. Unobservable in a test,
  //      but still real on a loaded machine -- and the cost of losing the bet is a
  //      gate reading an empty trust root.
  //
  // So assert the MECHANISM that provides the guarantee, deterministically:
  // renaming a fresh file into place swaps in a NEW INODE, while an in-place
  // write reuses the existing one. Inode change is exactly the difference between
  // "readers see old or new" and "readers can see neither".
  const f = fixture(null);
  try {
    const path = join(f.root, '.adlc/current-ticket.json');
    writeActiveTicket(f.root, { id: 'T1', ticketHash: hashOf(f.snapshot, 'T1') });
    const first = statSync(path).ino;

    writeActiveTicket(f.root, { id: 'T2', ticketHash: hashOf(f.snapshot, 'T2') });
    const second = statSync(path).ino;

    assert.notEqual(
      second,
      first,
      'writeActiveTicket must rename a fresh file into place (new inode). Reusing the inode means it truncated and rewrote the live pointer, exposing a window where a concurrently-reading gate sees an empty trust root.',
    );
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).id, 'T2');
  } finally { f.cleanup(); }
});

test('atomic: the writer leaves no temp file behind', () => {
  const f = fixture(null);
  try {
    writeActiveTicket(f.root, { id: 'T1', ticketHash: hashOf(f.snapshot, 'T1') });
    writeActiveTicket(f.root, { id: 'T2', ticketHash: hashOf(f.snapshot, 'T2') });
    const entries = readdirSync(join(f.root, '.adlc'));
    assert.deepEqual(entries.filter((e) => e.startsWith('current-ticket')), ['current-ticket.json']);
  } finally { f.cleanup(); }
});

test('atomic: the writer refuses a pointer that would not satisfy the reader', () => {
  const f = fixture(null);
  try {
    assert.throws(() => writeActiveTicket(f.root, { id: '', ticketHash: 'x' }), /id/i);
    assert.throws(() => writeActiveTicket(f.root, { id: 'T1' }), /ticketHash/i);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// The domain API keeps its throwing contract.
// ---------------------------------------------------------------------------

test('provenance.resolveActiveTicket throws TicketStoreError codes and closes the hole', () => {
  const f = fixture(() => ({ tickett: 'T1' }));
  try {
    assert.throws(
      () => resolveActiveTicket(f.snapshot, { root: f.root, env: {} }),
      (e) => e.kind === 'invalid' && e.code === 'INVALID_CURRENT_TICKET',
      'the fail-open hole must be closed on the throwing domain API too',
    );
  } finally { f.cleanup(); }
});

test('provenance.resolveActiveTicket still returns null when inert', () => {
  const f = fixture(null);
  try {
    assert.equal(resolveActiveTicket(f.snapshot, { root: f.root, env: {} }), null);
  } finally { f.cleanup(); }
});

test('provenance.resolveActiveTicket still resolves and pins both hashes', () => {
  const f = fixture(null);
  try {
    writeActiveTicket(f.root, { id: 'T1', ticketHash: hashOf(f.snapshot, 'T1') });
    const active = resolveActiveTicket(f.snapshot, { root: f.root, env: {} });
    assert.equal(active.id, 'T1');
    assert.equal(active.ticketHash, hashOf(f.snapshot, 'T1'));
    assert.equal(active.storeHash, f.snapshot.hash);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// readActiveTicketPointer -- the parse layer on its own.
// ---------------------------------------------------------------------------

test('readActiveTicketPointer reports absence without inventing a ticket', () => {
  const f = fixture(null);
  try {
    const got = readActiveTicketPointer(f.root);
    assert.equal(got.ok, true);
    assert.equal(got.value.present, false);
  } finally { f.cleanup(); }
});

test('readActiveTicketPointer surfaces the alias it accepted', () => {
  const f = fixture(() => ({ ticket: 'T1', ticketHash: 'x' }));
  try {
    const got = readActiveTicketPointer(f.root);
    assert.equal(got.ok, true);
    assert.equal(got.value.id, 'T1');
    assert.equal(got.value.deprecatedAlias, 'ticket');
  } finally { f.cleanup(); }
});
