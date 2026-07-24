// t-herdr-4 verification: the board's logic surface. bin/board.mjs is thin
// TUI glue (probed 2026-07-23: overlay panes are real PTYs with pane ids and
// close when the process exits); everything decision-shaped is pinned here.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupBacklog, readLedgerTail, readLedgerByTicket, readLatestPhase, readTicketsViaExport, storeCacheKey, makeKeyedCache, ticketIdsFromStore, readdirBounded } from '../lib/adlc-state.mjs';
import { renderBoard } from '../lib/board-render.mjs';

let repo;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'adlc-herdr-board-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

const writeAdlc = (rel, content) => {
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', rel), content);
};

const t = (id, extra = {}) => ({ id, title: `title of ${id}`, completed: false, edges: [], ...extra });

// ---- groupBacklog ----

test('groupBacklog groups ready / in-flight / blocked with invariant #104 semantics', () => {
  const tickets = [
    t('t-done', { completed: true, edges: [{ to: 't-b' }] }),
    t('t-a', { edges: [{ to: 't-c' }] }),
    t('t-b'),
    t('t-c'),
  ];
  const groups = groupBacklog(tickets, 't-b');
  assert.deepEqual(groups.ready.map((x) => x.id), ['t-a']);
  assert.deepEqual(groups.inFlight.map((x) => x.id), ['t-b']);
  assert.deepEqual(groups.blocked.map((x) => x.id), ['t-c']);
});

test('groupBacklog fails soft on malformed input', () => {
  assert.deepEqual(groupBacklog(null, null), { ready: [], inFlight: [], blocked: [] });
});

// ---- readLedgerTail ----

test('readLedgerTail returns the last N parsed records, skipping torn lines', () => {
  const lines = [
    JSON.stringify({ seq: 1, gate: 'a', ticket: 't-1' }),
    JSON.stringify({ seq: 2, gate: 'b', ticket: 't-1' }),
    '{torn',
    JSON.stringify({ seq: 3, gate: 'c', ticket: 't-2' }),
  ];
  writeAdlc('manifest.jsonl', lines.join('\n'));
  const tail = readLedgerTail(repo, 2);
  assert.deepEqual(tail.map((r) => r.seq), [2, 3]);
});

test('readLedgerTail defaults to the display depth (8 of a deeper ledger)', () => {
  const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ seq: i + 1 }));
  writeAdlc('manifest.jsonl', lines.join('\n'));
  const tail = readLedgerTail(repo);
  assert.equal(tail.length, 8);
  assert.deepEqual(tail.map((r) => r.seq), [5, 6, 7, 8, 9, 10, 11, 12]);
});

test('readLedgerTail yields [] for a missing ledger or non-positive n', () => {
  assert.deepEqual(readLedgerTail(repo, 5), []);
  writeAdlc('manifest.jsonl', JSON.stringify({ seq: 1 }));
  assert.deepEqual(readLedgerTail(repo, 0), []);
});

test('readLedgerByTicket keeps the most recent record per ticket, not a raw tail', () => {
  // t-hot floods the tail; a raw slice(-2) would drop t-cold entirely.
  writeAdlc('manifest.jsonl', [
    JSON.stringify({ seq: 1, gate: 'a', ticket: 't-cold' }),
    JSON.stringify({ seq: 2, gate: 'b', ticket: 't-hot' }),
    JSON.stringify({ seq: 3, gate: 'c', ticket: 't-hot' }),
    JSON.stringify({ seq: 4, gate: 'd', ticket: 't-hot' }),
  ].join('\n'));
  const rows = readLedgerByTicket(repo, 8);
  assert.deepEqual(rows.map((r) => [r.ticket, r.seq]), [['t-cold', 1], ['t-hot', 4]]);
});

test('the ledger readers bound their work: a huge manifest still returns the recent tail', () => {
  // ~1.2MB of noise from one hot ticket, then the records we actually want at
  // the end. A whole-file parse would choke on history; the bounded tail read
  // must still surface the most-recent per-ticket rows.
  const noise = Array.from({ length: 12_000 }, (_, i) => JSON.stringify({ seq: i, ticket: 't-hot', data: { phase: 'p1' } }));
  noise.push(JSON.stringify({ seq: 99_998, ticket: 't-cold', data: { phase: 'p3' } }));
  noise.push(JSON.stringify({ seq: 99_999, ticket: 't-hot', data: { phase: 'p5' } }));
  writeAdlc('manifest.jsonl', noise.join('\n'));
  const rows = readLedgerByTicket(repo, 8);
  const hot = rows.find((r) => r.ticket === 't-hot');
  assert.equal(hot.seq, 99_999, 'latest t-hot record wins from the tail');
  assert.equal(readLatestPhase(repo, 't-hot'), 'P5');
});

test('readLedgerByTicket caps at n tickets and drops records without a ticket', () => {
  writeAdlc('manifest.jsonl', [
    JSON.stringify({ seq: 1, ticket: 't-a' }),
    JSON.stringify({ seq: 2, gate: 'no-ticket-here' }),
    JSON.stringify({ seq: 3, ticket: 't-b' }),
    JSON.stringify({ seq: 4, ticket: 't-c' }),
  ].join('\n'));
  assert.deepEqual(readLedgerByTicket(repo, 2).map((r) => r.ticket), ['t-b', 't-c']);
});

// ---- readTicketsViaExport ----

test('readTicketsViaExport parses the envelope the injected exporter writes', async () => {
  const tickets = [t('t-a'), t('t-b', { completed: true })];
  const runExport = async (_repoRoot, outPath) => {
    writeFileSync(outPath, JSON.stringify({ tickets }));
    return true;
  };
  assert.deepEqual(await readTicketsViaExport(repo, { runExport }), tickets);
});

test('readTicketsViaExport fails soft on exporter failure or a bad envelope', async () => {
  assert.equal(await readTicketsViaExport(repo, { runExport: async () => false }), null);
  const badExport = async (_r, outPath) => { writeFileSync(outPath, '{nope'); return true; };
  assert.equal(await readTicketsViaExport(repo, { runExport: badExport }), null);
  const wrongShape = async (_r, outPath) => { writeFileSync(outPath, JSON.stringify([1])); return true; };
  assert.equal(await readTicketsViaExport(repo, { runExport: wrongShape }), null);
});

// ---- ticketIdsFromStore (filesystem read — the RCE-safe worktree.created path) ----

test('ticketIdsFromStore reads ids from sharded shard filenames (hash-shape aware)', () => {
  const h = 'a'.repeat(64); // a real shard hash is 64-hex
  mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
  writeFileSync(join(repo, '.adlc', 'tickets', `t-a--${h}.json`), '{}');
  writeFileSync(join(repo, '.adlc', 'tickets', `t-b--${h}.json`), '{}');
  writeFileSync(join(repo, '.adlc', 'tickets', 'notjson.txt'), 'x'); // ignored
  writeFileSync(join(repo, '.adlc', 'tickets', 't-c.json'), '{}'); // no '--' → strip .json
  writeFileSync(join(repo, '.adlc', 'tickets', `bug--login--${h}.json`), '{}'); // id has '--', real hash → id kept
  writeFileSync(join(repo, '.adlc', 'tickets', 'feat--copy.json'), '{}'); // hand-copied, '--' in id, NO hash → whole id
  assert.deepEqual(ticketIdsFromStore(repo).sort(), ['bug--login', 'feat--copy', 't-a', 't-b', 't-c']);
});

test('ticketIdsFromStore falls back to the legacy tickets.json array', () => {
  writeAdlc('tickets.json', JSON.stringify({ tickets: [{ id: 'T1' }, { id: 'T2' }, { nope: true }] }));
  assert.deepEqual(ticketIdsFromStore(repo).sort(), ['T1', 'T2']);
});

test('ticketIdsFromStore fails soft to [] on a missing store, a bad root, or malformed legacy json', () => {
  assert.deepEqual(ticketIdsFromStore(repo), []); // no store yet
  assert.deepEqual(ticketIdsFromStore(null), []);
  assert.deepEqual(ticketIdsFromStore(join(repo, 'does-not-exist')), []);
  writeAdlc('tickets.json', '{not json');
  assert.deepEqual(ticketIdsFromStore(repo), []);
});

test('ticketIdsFromStore rejects any RELATIVE root — must not read a store from the process cwd', () => {
  // Empty, '.', './x' would all `join` against the cwd and leak the host store.
  for (const rel of ['', '.', './x', 'relative/path', '..']) {
    assert.deepEqual(ticketIdsFromStore(rel), [], `${JSON.stringify(rel)} must fail closed`);
  }
});

test('ticketIdsFromStore skips a legacy store that is not a regular file (FIFO/dir → no blocking read)', () => {
  // A non-regular file at tickets.json (here: a directory) must be skipped, not
  // read — a synchronous read of a FIFO would hang the event process.
  mkdirSync(join(repo, '.adlc', 'tickets.json'), { recursive: true });
  assert.deepEqual(ticketIdsFromStore(repo), []);
});

// ---- readdirBounded (DoS bound on an untrusted shard directory) ----

test('readdirBounded stops at maxEntries — a huge dir can never be fully materialized', () => {
  const d = join(repo, 'many');
  mkdirSync(d, { recursive: true });
  for (let i = 0; i < 5; i += 1) writeFileSync(join(d, `f${i}`), '');
  // 5 files on disk, but a cap of 3 must return exactly 3 (never 4/5): pins the
  // `names.length < maxEntries` bound so a mutation to <= or removal is caught.
  assert.equal(readdirBounded(d, 3).length, 3);
  // A cap at/above the count returns them all.
  assert.equal(readdirBounded(d, 10).length, 5);
});

test('readdirBounded fails soft to [] for a missing or non-directory path', () => {
  assert.deepEqual(readdirBounded(join(repo, 'nope'), 100), []);
  const f = join(repo, 'afile');
  writeFileSync(f, 'x');
  assert.deepEqual(readdirBounded(f, 100), []); // a file is not a directory
});

// ---- storeCacheKey (mtime-gate for the board's export cache) ----

test('storeCacheKey uses the 0 sentinel when no store exists, keyed by repo', () => {
  assert.equal(storeCacheKey(repo), `${repo}@0`); // .adlc has no tickets store yet
});

test('storeCacheKey reflects the store mtime and advances when the store changes', () => {
  mkdirSync(join(repo, '.adlc', 'tickets'), { recursive: true });
  const k1 = storeCacheKey(repo);
  assert.notEqual(k1, `${repo}@0`, 'a real store must not use the 0 sentinel');
  assert.ok(k1.startsWith(`${repo}@`));
  // A later write bumps the tickets-dir mtime → a different key (cache invalidates).
  writeFileSync(join(repo, '.adlc', 'tickets', 't-x1.json'), '{}');
  const k2 = storeCacheKey(repo);
  assert.notEqual(k2, k1, 'adding a shard must change the key');
});

test('storeCacheKey falls back to the legacy tickets.json file mtime', () => {
  writeAdlc('tickets.json', '{"tickets":[]}'); // legacy single-file store
  assert.ok(storeCacheKey(repo).startsWith(`${repo}@`));
  assert.notEqual(storeCacheKey(repo), `${repo}@0`);
});

// ---- makeKeyedCache (the board's mtime-gated export cache) ----

test('makeKeyedCache reads once, serves the cache on a stable key, re-reads when it changes', async () => {
  let reads = 0;
  let key = 'k1';
  let value = 'A';
  const cached = makeKeyedCache(() => key, async () => { reads += 1; return value; });
  assert.equal(await cached('repo'), 'A');
  assert.equal(reads, 1, 'first call must read');
  assert.equal(await cached('repo'), 'A');
  assert.equal(reads, 1, 'a stable key must NOT re-read (cache hit)'); // kills key===key inversion
  key = 'k2';
  value = 'B';
  assert.equal(await cached('repo'), 'B');
  assert.equal(reads, 2, 'a changed key must re-read');
});

test('makeKeyedCache caches a null value (does not treat null as empty and re-read)', async () => {
  let reads = 0;
  const cached = makeKeyedCache(() => 'same', async () => { reads += 1; return null; });
  assert.equal(await cached('x'), null);
  assert.equal(await cached('x'), null);
  assert.equal(reads, 1, 'null must be cached, not re-read every call');
});

// ---- renderBoard ----

const baseState = () => ({
  width: 80,
  repoRoot: '/repo',
  active: { state: 'active', id: 't-b' },
  phase: 'P4',
  groups: {
    ready: [t('t-a')],
    inFlight: [t('t-b')],
    blocked: [t('t-c')],
  },
  paneRows: [{ paneId: 'w4:p2', agent: 'claude', agentStatus: 'working', ticket: 't-b' }],
  ledger: [{ seq: 9, gate: 'rails-frozen', ticket: 't-b' }],
});

test('renderBoard shows header, groups with counts, pane mapping, and ledger', () => {
  const out = renderBoard(baseState());
  assert.ok(out.includes('/repo'));
  assert.ok(out.includes('t-b'));
  assert.ok(out.includes('P4'));
  assert.ok(out.includes('ready (1)'));
  assert.ok(out.includes('in-flight (1)'));
  assert.ok(out.includes('blocked (1)'));
  assert.ok(out.includes('title of t-a'));
  assert.ok(out.includes('w4:p2'));
  assert.ok(out.includes('working'));
  assert.ok(out.includes('rails-frozen'));
});

test('renderBoard sanitizes hostile ticket titles and ledger gate names', () => {
  const state = baseState();
  state.groups.ready = [t('t-evil', { title: '\x1b]0;pwn\x07innocent\x1b[31m' })];
  state.ledger = [{ seq: 1, gate: '\x1b[2Jclear', ticket: 't-x' }];
  const out = renderBoard(state);
  assert.ok(!out.includes('\x1b]'), 'no OSC survives');
  assert.ok(!out.includes('\x1b[31m'), 'no data-borne CSI survives');
  assert.ok(!out.includes('\x1b[2J'), 'no data-borne clear survives');
  assert.ok(out.includes('innocent'));
});

test('renderBoard truncates rows to the pane width', () => {
  const state = baseState();
  state.width = 30;
  state.groups.ready = [t('t-long', { title: 'x'.repeat(200) })];
  for (const line of renderBoard(state).split('\n')) {
    // measure without our own ANSI styling
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(visible.length <= 30, `line exceeds width: ${visible.length}`);
  }
});

test('renderBoard pins the width floor at 20 on a content row, not just the separator', () => {
  const state = baseState();
  state.width = 5; // below the floor — clamp must land exactly on 20
  state.groups.ready = [t('t-long', { title: 'y'.repeat(100) })];
  const lines = renderBoard(state).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(lines.every((l) => l.length <= 20), 'no line may overflow the floor');
  // The long ticket row must itself truncate to exactly 20 — a separator being
  // 20 wide must not be what satisfies this.
  const contentRow = lines.find((l) => l.includes('t-long'));
  assert.ok(contentRow, 'the long ticket row must be present');
  assert.equal(contentRow.length, 20, 'the content row fills exactly to the floor');
});

test('renderBoard clamps to `height`, ending with a "…N more" marker (no scroll)', () => {
  const state = baseState();
  state.height = 6;
  state.groups.ready = Array.from({ length: 40 }, (_, i) => t(`t-${i}`));
  const lines = renderBoard(state).split('\n');
  assert.equal(lines.length, 6, 'output must not exceed the height');
  assert.ok(lines[lines.length - 1].includes('more'), 'the last line marks the truncation');
});

test('renderBoard does not clamp when the frame fits within `height`', () => {
  const state = baseState();
  state.height = 100;
  const out = renderBoard(state);
  assert.ok(!out.includes('more (resize'), 'a fitting frame is not truncated');
  assert.ok(out.includes('rails-frozen'), 'the full frame renders');
});

test('renderBoard renders calm empty states', () => {
  const out = renderBoard({
    width: 80, repoRoot: '/repo', active: { state: 'absent' }, phase: null,
    groups: { ready: [], inFlight: [], blocked: [] }, paneRows: [], ledger: [],
  });
  assert.ok(out.includes('none'));
  assert.ok(out.toLowerCase().includes('no tickets'));
});
