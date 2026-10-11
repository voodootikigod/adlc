// Issue #830: the ledger readers must see the manifest FOREST, not only the
// frozen root `.adlc/manifest.jsonl`. A segmented repo appends every new
// record to `.adlc/manifest.d/<branch>-<ULID>.jsonl`, so a root-only reader
// shows a ledger frozen at the cutover date and loses the pane phase token —
// silently, which is the dangerous shape. These tests pin the three readers
// against a segmented fixture (with a planted symlink and nested directory
// that must never be read), the source enumeration + ordering, the pure merge,
// and byte-identical behaviour on a never-segmented repo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  ledgerSources, mergeLedgerRecords, readLedgerTail, readLedgerByTicket, readLatestPhase,
  MAX_LEDGER_SEGMENTS,
} from '../lib/adlc-state.mjs';

// Every fixture directory is registered here and removed once, after the file.
const fixtures = new Set();
// Directories whose permissions a test restricted: restore them before removal.
const restricted = new Set();
after(() => {
  for (const dir of restricted) { try { chmodSync(dir, 0o700); } catch { /* best-effort */ } }
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'adlc-herdr-forest-'));
  fixtures.add(repo);
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  return repo;
}
const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n');
const writeRoot = (repo, records) => writeFileSync(join(repo, '.adlc', 'manifest.jsonl'), lines(records));
const writeSegment = (repo, name, records) => {
  mkdirSync(join(repo, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'manifest.d', name), lines(records));
};

const SEG_MAIN = 'main-01ARZ3NDEKTSV4RRFFQ69G5FAV.jsonl';
const SEG_FEAT = 'feat-x-01BX5ZZKBKACTAV9WEVGEMMVRZ.jsonl';
// A readable file OUTSIDE the ledger that a symlink will point at: its content
// must never surface through any reader.
const LEAK_MARKER = 'LEAKED-THROUGH-SYMLINK';

function segmentedRepo() {
  const repo = makeRepo();
  writeRoot(repo, [
    { seq: 1, ts: '2026-01-01T00:00:00.000Z', gate: 'coldstart', ticket: 't-old', data: { phase: 'p0' } },
    { seq: 2, ts: '2026-01-02T00:00:00.000Z', gate: 'rails', ticket: 't-old', data: { phase: 'p3' } },
  ]);
  writeSegment(repo, SEG_MAIN, [
    { seq: 1, ts: '2026-02-01T00:00:00.000Z', gate: 'p4-build', ticket: 't-old', data: { phase: 'p4' } },
  ]);
  writeSegment(repo, SEG_FEAT, [
    { seq: 1, ts: '2026-03-01T00:00:00.000Z', gate: 'coldstart', ticket: 't-seg-only', data: { phase: 'p2' } },
    { seq: 2, ts: '2026-03-02T00:00:00.000Z', gate: 'prosecute', ticket: 't-seg-only', data: { phase: 'p5' } },
  ]);
  // Planted objects a hardened reader must skip: a symlink named like a segment
  // pointing outside the ledger, and a nested directory named like a segment.
  const leak = join(repo, 'outside.txt');
  writeFileSync(leak, `${JSON.stringify({ seq: 9, ts: '2099-01-01T00:00:00.000Z', ticket: LEAK_MARKER, data: { phase: 'p9' } })}\n`);
  symlinkSync(leak, join(repo, '.adlc', 'manifest.d', 'evil-01CCCCCCCCCCCCCCCCCCCCCCCC.jsonl'));
  mkdirSync(join(repo, '.adlc', 'manifest.d', 'nested-01DDDDDDDDDDDDDDDDDDDDDDDD.jsonl'));
  mkdirSync(join(repo, '.adlc', 'manifest.d', 'evil-dir'));
  return repo;
}

// ---- AC1: the three readers see segment records --------------------------

test('AC1 readLedgerTail includes segment records, newest last, and never the symlink target', () => {
  const repo = segmentedRepo();
  const tail = readLedgerTail(repo, 8);
  assert.deepEqual(tail.map((r) => r.ts), [
    '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
    '2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z',
  ]);
  assert.ok(!JSON.stringify(tail).includes(LEAK_MARKER), 'symlinked file content must never be read');
});

test('AC1 readLedgerByTicket shows a ticket whose only evidence is segment-side', () => {
  const repo = segmentedRepo();
  const byTicket = readLedgerByTicket(repo, 8);
  const segOnly = byTicket.find((r) => r.ticket === 't-seg-only');
  assert.ok(segOnly, 'segment-only ticket must appear');
  assert.equal(segOnly.gate, 'prosecute'); // its LATEST record, not its first
  // t-old's latest activity is the segment record (p4), not the frozen root (p3).
  assert.equal(byTicket.find((r) => r.ticket === 't-old').data.phase, 'p4');
  // Per-ticket recency order: t-old (Feb) before t-seg-only (Mar).
  assert.deepEqual(byTicket.map((r) => r.ticket), ['t-old', 't-seg-only']);
  assert.ok(!byTicket.some((r) => r.ticket === LEAK_MARKER));
});

test('AC1 readLatestPhase returns the newest merged phase for a segment-only ticket, uppercased', () => {
  const repo = segmentedRepo();
  assert.equal(readLatestPhase(repo, 't-seg-only'), 'P5');
  assert.equal(readLatestPhase(repo, 't-old'), 'P4'); // segment beats frozen root
  assert.equal(readLatestPhase(repo, LEAK_MARKER), null);
});

// ---- AC2: ledgerSources enumeration + ordering, mergeLedgerRecords ---------

test('AC2 ledgerSources: root first, then regular .jsonl segments by ULID suffix; symlinks and dirs skipped', () => {
  const repo = segmentedRepo();
  writeSegment(repo, 'zzz-no-ulid-here.jsonl', [{ seq: 1 }]); // unparseable suffix → first, by name
  writeSegment(repo, 'aaa-also-no-ulid.jsonl', [{ seq: 1 }]);
  writeSegment(repo, 'notes.txt', [{ seq: 1 }]); // wrong extension → excluded
  // Two branches that minted the SAME ULID (a rebase can do this): ties by name.
  writeSegment(repo, 'zeta-01BX5ZZKBKACTAV9WEVGEMMVRZ.jsonl', [{ seq: 1 }]);
  writeSegment(repo, 'alpha-01BX5ZZKBKACTAV9WEVGEMMVRZ.jsonl', [{ seq: 1 }]);
  const sources = ledgerSources(repo).map((p) => basename(p));
  assert.deepEqual(sources, [
    'manifest.jsonl',
    'aaa-also-no-ulid.jsonl',
    'zzz-no-ulid-here.jsonl',
    SEG_MAIN, // 01ARZ… < 01BX5…
    'alpha-01BX5ZZKBKACTAV9WEVGEMMVRZ.jsonl',
    SEG_FEAT, // 'feat-x-…' between 'alpha-…' and 'zeta-…' for the same ULID
    'zeta-01BX5ZZKBKACTAV9WEVGEMMVRZ.jsonl',
  ]);
  // The ULID is compared case-insensitively (Crockford base32 is case-insensitive).
  writeSegment(repo, 'lower-01arz3ndektsv4rrffq69g5fav.jsonl', [{ seq: 1 }]);
  const again = ledgerSources(repo).map((p) => basename(p));
  assert.deepEqual(again.slice(3, 5), ['lower-01arz3ndektsv4rrffq69g5fav.jsonl', SEG_MAIN]);
});

test('AC2 ledgerSources: a missing manifest.d yields only the root; a missing root yields []', () => {
  const repo = makeRepo();
  assert.deepEqual(ledgerSources(repo), []);
  writeRoot(repo, [{ seq: 1 }]);
  assert.deepEqual(ledgerSources(repo).map((p) => basename(p)), ['manifest.jsonl']);
  assert.deepEqual(ledgerSources(join(repo, 'does-not-exist')), []);
});

test('AC2 ledgerSources is bounded at MAX_LEDGER_SEGMENTS (+ root) and does not fail soft to []', () => {
  const repo = makeRepo();
  writeRoot(repo, [{ seq: 1 }]);
  for (let i = 0; i < 300; i += 1) {
    writeSegment(repo, `b-${String(i).padStart(26, '0')}.jsonl`, [{ seq: i }]);
  }
  assert.equal(MAX_LEDGER_SEGMENTS, 256);
  const sources = ledgerSources(repo);
  assert.equal(sources.length, MAX_LEDGER_SEGMENTS + 1);
  assert.equal(basename(sources[0]), 'manifest.jsonl');
});

test('AC2 mergeLedgerRecords orders by ts ascending; ties by source then line; missing ts sorts first in source order', () => {
  const a = [
    { id: 'a0', ts: '2026-02-01T00:00:00.000Z' },
    { id: 'a1' }, // no ts
    { id: 'a2', ts: '2026-01-01T00:00:00.000Z' },
  ];
  const b = [
    { id: 'b0', ts: '2026-01-01T00:00:00.000Z' }, // ties with a2 → a2 first (source order)
    { id: 'b1', ts: 42 }, // non-string ts → treated as missing
    { id: 'b2', ts: '2026-03-01T00:00:00.000Z' },
  ];
  const beforeA = JSON.stringify(a);
  const beforeB = JSON.stringify(b);
  const merged = mergeLedgerRecords([a, b]);
  assert.deepEqual(merged.map((r) => r.id), ['a1', 'b1', 'a2', 'b0', 'a0', 'b2']);
  assert.equal(JSON.stringify(a), beforeA, 'input list a must not be mutated');
  assert.equal(JSON.stringify(b), beforeB, 'input list b must not be mutated');
  assert.notEqual(merged, a);
  assert.notEqual(merged, b);
  assert.deepEqual(mergeLedgerRecords([]), []);
  assert.deepEqual(mergeLedgerRecords([[], []]), []);
});

test('AC2 mergeLedgerRecords keeps line order within one source when ts is equal or absent', () => {
  const src = [{ id: 0, ts: 'x' }, { id: 1, ts: 'x' }, { id: 2, ts: 'x' }, { id: 3 }, { id: 4 }];
  assert.deepEqual(mergeLedgerRecords([src]).map((r) => r.id), [3, 4, 0, 1, 2]);
});

// ---- AC3: never-segmented repo is byte-identical to today -----------------

test('AC3 never-segmented repo: readLedgerTail matches the pre-forest contract', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.adlc', 'manifest.jsonl'), [
    JSON.stringify({ seq: 1, gate: 'a', ticket: 't-1' }),
    JSON.stringify({ seq: 2, gate: 'b', ticket: 't-1' }),
    '{torn',
    JSON.stringify({ seq: 3, gate: 'c', ticket: 't-2' }),
  ].join('\n'));
  assert.deepEqual(readLedgerTail(repo, 2).map((r) => r.seq), [2, 3]);
  assert.deepEqual(readLedgerTail(repo), [
    { seq: 1, gate: 'a', ticket: 't-1' }, { seq: 2, gate: 'b', ticket: 't-1' }, { seq: 3, gate: 'c', ticket: 't-2' },
  ]);
  assert.deepEqual(readLedgerTail(repo, 0), []);
});

test('AC3 never-segmented repo: readLedgerByTicket and readLatestPhase match the pre-forest contract', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, '.adlc', 'manifest.jsonl'), [
    JSON.stringify({ seq: 1, gate: 'a', ticket: 't-cold' }),
    JSON.stringify({ seq: 2, gate: 'b', ticket: 't-hot' }),
    JSON.stringify({ seq: 3, gate: 'c', ticket: 't-hot', data: { phase: 'p3' } }),
    JSON.stringify({ seq: 4, gate: 'd' }), // no ticket → dropped by the per-ticket view
    JSON.stringify({ seq: 5, gate: 'e', ticket: 't-hot', data: { phase: 'p4' } }),
  ].join('\n'));
  assert.deepEqual(readLedgerByTicket(repo, 2).map((r) => [r.ticket, r.seq]), [['t-cold', 1], ['t-hot', 5]]);
  assert.deepEqual(readLedgerByTicket(repo, 1).map((r) => r.seq), [5]);
  assert.equal(readLatestPhase(repo, 't-hot'), 'P4');
  assert.equal(readLatestPhase(repo, 't-cold'), null);
  assert.equal(readLatestPhase(join(repo, 'nowhere'), 't-hot'), null);
});

test('AC3 a torn trailing line in a segment is skipped exactly as in the root', () => {
  const repo = makeRepo();
  writeRoot(repo, [{ ticket: 't-x1', ts: '2026-01-01T00:00:00.000Z', data: { phase: 'p1' } }]);
  mkdirSync(join(repo, '.adlc', 'manifest.d'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'manifest.d', SEG_MAIN),
    `${JSON.stringify({ ticket: 't-x1', ts: '2026-02-01T00:00:00.000Z', data: { phase: 'p5' } })}\n{"tor`);
  assert.equal(readLatestPhase(repo, 't-x1'), 'P5');
  // Sanity: the fixture symlink leak marker file is really readable text, so a
  // reader that followed the link WOULD have surfaced it (guards the AC1 assertion).
  const seg = segmentedRepo();
  assert.ok(readFileSync(join(seg, 'outside.txt'), 'utf8').includes(LEAK_MARKER));
});

test('AC2 ledgerSources excludes segment entries that cannot be stat-ed (listable but unsearchable manifest.d)', () => {
  // root bypasses directory search permission, so under root the restriction
  // has no effect and all three sources stay readable — assert that instead.
  const restrictionApplies = typeof process.getuid !== 'function' || process.getuid() !== 0;
  const repo = makeRepo();
  writeRoot(repo, [{ seq: 1 }]);
  writeSegment(repo, SEG_MAIN, [{ seq: 1 }]);
  writeSegment(repo, SEG_FEAT, [{ seq: 1 }]);
  const segDir = join(repo, '.adlc', 'manifest.d');
  restricted.add(segDir);
  chmodSync(segDir, 0o600); // readdir works (r), lstat of a child does not (no x)
  // The names ARE listed, so a reader that guessed "regular" on a failed lstat
  // would hand back two paths it can never open.
  const expectedSources = restrictionApplies ? ['manifest.jsonl'] : ['manifest.jsonl', SEG_MAIN, SEG_FEAT];
  assert.deepEqual(ledgerSources(repo).map((p) => basename(p)), expectedSources);
  assert.deepEqual(readLedgerTail(repo, 8).map((r) => r.seq), restrictionApplies ? [1] : [1, 1, 1]);
  chmodSync(segDir, 0o700);
  assert.equal(ledgerSources(repo).length, 3, 'restoring search permission restores the segments');
});
