// t-herdr-4 verification: the board's logic surface. bin/board.mjs is thin
// TUI glue (probed 2026-07-23: overlay panes are real PTYs with pane ids and
// close when the process exits); everything decision-shaped is pinned here.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupBacklog, readLedgerTail, readLedgerByTicket, readLatestPhase, readTicketsViaExport, storeCacheKey, makeKeyedCache, ticketIdsFromStore, readdirBounded } from '../lib/adlc-state.mjs';
import { renderBoard, boardFooter, composeFrame, frameGeometry, withCurrentGeometry } from '../lib/board-render.mjs';
import { displayWidth } from '../lib/display-width.mjs';

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
  const ticketsDir = join(repo, '.adlc', 'tickets');
  mkdirSync(ticketsDir, { recursive: true });
  // Rewind the dir mtime to a fixed past instant BEFORE taking the first key.
  // Without this, mkdir and the shard write below can land inside the same
  // kernel timestamp tick (~1-4ms granularity on Linux), the dir mtime never
  // visibly advances, and the k1 !== k2 assertion flakes — it passed on macOS
  // only by APFS timing luck (found via the mutation-gate CI baseline, #378).
  const past = (Date.now() - 5000) / 1000;
  utimesSync(ticketsDir, past, past);
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

test('renderBoard emits to the REAL pane width, not the 20-column layout floor', () => {
  // This test previously required a content row to fill exactly 20 cells at
  // width 5 — it pinned the floor as an EMISSION width. That is what made a
  // sub-20-column pane wrap every row: clampWidth's floor exists to keep the
  // layout arithmetic from degenerating, and is not a licence to write past the
  // terminal. The invariant is now "never wider than the pane we were given".
  for (const width of [1, 5, 12, 19, 20, 40]) {
    const state = baseState();
    state.width = width;
    state.groups.ready = [t('t-long', { title: 'y'.repeat(100) })];
    const lines = renderBoard(state).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    for (const line of lines) {
      assert.ok(displayWidth(line) <= width, `width ${width}: line is ${displayWidth(line)} cells: ${line}`);
    }
    // A content row must still FILL the pane — truncating everything to nothing
    // would satisfy the bound above while rendering an empty board.
    assert.ok(lines.some((l) => displayWidth(l) === width), `width ${width}: no row fills the pane`);
  }
});

test('an absent or invalid width still falls back to the 80-column default', () => {
  for (const width of [undefined, null, NaN, -5, 0]) {
    const state = baseState();
    state.width = width;
    const lines = renderBoard(state).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 80, `width ${JSON.stringify(width)}: line is ${displayWidth(line)} cells`);
    }
  }
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

// ---- header: the repo root must never starve the ticket ----
//
// Every renderBoard test above uses repoRoot '/repo', so none of them could see
// that the header composes `repo <root> · ticket <id>` and then truncates the
// whole line at the pane width: a deep root ate the ticket and the phase — the
// only two fields on that line that ever change. It reproduced on macOS, where
// os.tmpdir() is ~48 chars, as board-e2e's 't-e2e' assertion; on Linux CI /tmp
// is short enough to hide it.

const headerOf = (state) => renderBoard(state).split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '');

test('renderBoard keeps the ticket and phase visible under a deep repo root', () => {
  const state = baseState();
  state.repoRoot = `/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/adlc-herdr-board-e2e-Ab3xY9/repo`;
  const header = headerOf(state);
  assert.ok(header.includes('t-b'), `the active ticket must survive: ${header}`);
  assert.ok(header.includes('P4'), `the phase must survive: ${header}`);
  assert.ok(header.length <= 80, `the header must still fit the width: ${header.length}`);
});

test('the elided root keeps its tail — the identifying part of a path', () => {
  const state = baseState();
  state.repoRoot = '/very/long/prefix/that/must/be/dropped/from/the/front/myrepo';
  state.width = 60;
  const header = headerOf(state);
  assert.ok(header.includes('myrepo'), `the leaf must survive: ${header}`);
  assert.ok(header.includes('<'), 'elision must be marked, not silent');
  assert.ok(!header.includes('/very/long/prefix'), 'the dropped prefix must be gone');
});

test('the leaf survives a root far longer than the pane is wide', () => {
  // Guards an order-of-operations trap: sanitizing the root with the WIDTH as
  // its cap clips the front of the string first, so the "tail" the elision then
  // keeps is the middle of the path and the leaf is gone. The sanitize cap must
  // bound the root's own length, not the pane's.
  const state = baseState();
  state.repoRoot = `${'/segment'.repeat(40)}/myrepo`;
  state.width = 80;
  const header = headerOf(state);
  assert.ok(header.includes('myrepo'), `the leaf must survive: ${header}`);
  assert.ok(header.includes('t-b'), 'the ticket must survive too');
  assert.ok(header.length <= 80);
});

test('a short repo root is left exactly as-is (no gratuitous elision)', () => {
  assert.equal(headerOf(baseState()), 'ADLC board | repo /repo | ticket t-b | P4');
});

test('the ticket and phase survive every pane width, not just wide ones', () => {
  // The first version of this test asserted only that the line fit the width —
  // which a header showing nothing but the repo path also satisfies. It passed
  // while widths 20-40 rendered "ADLC board | repo /var/folders/s1/51j2xg" with
  // no ticket at all. Assert the FIELDS survive, because that is the invariant.
  for (const width of [20, 24, 30, 40, 60, 100]) {
    const state = baseState();
    state.width = width;
    state.repoRoot = '/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/deep/repo';
    const header = headerOf(state);
    assert.ok(header.includes('t-b'), `width ${width}: ticket lost — ${header}`);
    assert.ok(header.includes('P4'), `width ${width}: phase lost — ${header}`);
    assert.ok(header.length <= Math.max(20, width), `width ${width}: header is ${header.length}`);
  }
});

test('the header cannot overflow however extreme the inputs', () => {
  for (const width of [5, 20, 21, 37, 80]) {
    const state = baseState();
    state.width = width;
    state.repoRoot = '/'.padEnd(300, 'x');
    state.active = { state: 'active', id: 'T-'.padEnd(120, 'z') };
    state.phase = 'P'.repeat(90);
    const header = headerOf(state);
    assert.ok(header.length <= Math.max(20, width), `width ${width}: header is ${header.length}`);
  }
});

test('an over-long phase cannot erase the phase AND the id tail', () => {
  // `phase` arrives from the manifest as an unrestricted string. A long one
  // inflated the suffix past the id-elision threshold, so the whole thing fell
  // through to a plain truncation and BOTH fields vanished — the failure this
  // degradation exists to prevent. The extreme-input test above could not catch
  // it: asserting only that the line fits is satisfied by a line showing
  // nothing useful. Both fields must appear; each may be elided.
  const id = 'T-01JXT21Q000W3GE1R70W3GE1R7';
  for (const phase of ['P4', 'P4-review', 'P10-integration-verify']) {
    for (const width of [20, 24, 30, 40, 60]) {
      const state = baseState();
      state.width = width;
      state.repoRoot = '/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/deep/repo';
      state.active = { state: 'active', id };
      state.phase = phase;
      const header = headerOf(state);
      const context = `width ${width}, phase "${phase}": ${header}`;
      assert.ok(header.includes(id.slice(-4)), `id tail lost — ${context}`);
      assert.ok(header.includes(phase.slice(0, 2)), `phase lost — ${context}`);
      assert.ok(header.length <= Math.max(20, width), `overflow — ${context}`);
    }
  }
});

test('no row exceeds the pane in terminal CELLS, not just code units', () => {
  // A CJK path is two cells per character, so a header measured 80 by .length
  // occupied ~160 and wrapped. The redraw is cursor-home, not an alternate
  // screen, so a wrapped line corrupts the frame shape on every refresh.
  // Each row's content must be long enough in CELLS to force truncation, or the
  // assertion passes under the old code-unit `cut` too and proves nothing. A
  // first version used ~14 CJK characters per row: 38 cells in a 40-column
  // pane, so nothing was ever truncated and reverting the fix did not fail it.
  const state = baseState();
  state.width = 40;
  state.repoRoot = `/Users/開発/${'プロジェクト'.repeat(6)}/リポジトリ`;
  state.groups.ready = [t('t-cjk', { title: '日本語のチケットのタイトルです'.repeat(3) })];
  state.paneRows = [{ paneId: 'w1:p1', agent: 'クロード'.repeat(4), agentStatus: '作業中'.repeat(4), ticket: 't-cjk' }];
  state.ledger = [{ seq: 1, gate: '検証ゲート'.repeat(5), ticket: 't-cjk' }];
  const lines = renderBoard(state).split('\n').map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 40, `line occupies ${displayWidth(line)} cells: ${line}`);
  }
  // DENOMINATOR: at least one row must actually have been cut, or the loop
  // above is asserting over content that always fit.
  assert.ok(lines.some((line) => displayWidth(line) > 30), 'rows must be filling the pane, not trivially short');
});

test('the footer fits the pane, so the reserved frame height holds', () => {
  // renderBoard clamps the BODY, but draw() appends `\n\n${boardFooter(...)}`
  // and gather() reserves exactly two rows for it. A fixed 57-cell footer wraps
  // to three rows in a 20-column pane, so every cursor-home redraw wrote more
  // physical rows than were reserved and the pane scrolled.
  for (const width of [20, 24, 40, 80, 120]) {
    const footer = boardFooter(3000, width).replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(displayWidth(footer) <= width, `width ${width}: footer is ${displayWidth(footer)} cells: ${footer}`);
    assert.ok(!footer.includes('\n'), 'the footer is a single row');
    assert.ok(footer.includes('q'), `width ${width}: quit must always be discoverable: ${footer}`);
  }
});

test('the whole frame — body plus footer — fits the pane at every width', () => {
  for (const width of [20, 40, 80]) {
    const state = baseState();
    state.width = width;
    state.repoRoot = '/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/deep/repo';
    state.groups.ready = [t('t-long', { title: '日本語のタイトル'.repeat(5) })];
    const frame = `${renderBoard(state)}\n\n${boardFooter(3000, width)}`;
    for (const line of frame.split('\n')) {
      const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
      assert.ok(displayWidth(visible) <= width, `width ${width}: line is ${displayWidth(visible)} cells: ${visible}`);
    }
  }
});

test('composeFrame emits no trailing newline — a bottom-row line feed scrolls', () => {
  // gather() reserves exactly two rows for the blank line and footer, so on a
  // height-clamped frame the footer sits on the terminal's LAST row. The old
  // draw() wrote "\n\x1b[0J" after it: a line feed from the bottom row scrolls
  // the viewport BEFORE erase-below runs, displacing the frame on every 3s
  // refresh — with the height clamp and bounded footer both working.
  const frame = composeFrame('body line', 'q quit');
  assert.ok(frame.startsWith('\x1b[H'), 'the redraw must home the cursor');
  assert.ok(frame.endsWith('\x1b[0J'), 'erase-below must be last');
  assert.ok(!frame.includes('\n\x1b[0J'), 'no line feed may precede erase-below');
  assert.equal(frame.split('\n').length, 3, 'body + blank + footer, and nothing after');
  for (const row of frame.split('\n')) {
    assert.ok(row.includes('\x1b[K'), `every row erases to end of line: ${JSON.stringify(row)}`);
  }
});

test('the frame never exceeds a tiny pane, shedding chrome before content', () => {
  // gather() floored the body at four rows and composeFrame always added two,
  // so a pane of 1-5 rows received six lines and scrolled on every redraw —
  // the failure the whole height clamp exists to prevent, at the one size
  // nothing tested. The blank separator goes first, then the footer.
  for (const rows of [1, 2, 3, 4, 5, 6, 10]) {
    const state = baseState();
    state.width = 40;
    state.height = Math.max(1, rows - 2); // exactly what gather() asks for
    state.groups.ready = Array.from({ length: 30 }, (_, i) => t(`t-${i}`));
    const frame = composeFrame(renderBoard(state), boardFooter(3000, 40), rows);
    const lines = frame.split('\n');
    assert.ok(lines.length <= rows, `rows ${rows}: emitted ${lines.length} physical rows`);
    // Fitting is not enough — a frame of pure chrome fits every pane. The
    // active ticket is the single most valuable row, so it must survive even
    // at one row, where a "resize me" marker used to take its place and tell
    // the operator something they can already see.
    assert.match(frame, /t-b/, `rows ${rows}: the active ticket must survive`);
  }
});

test('renderBoard honors a one-row height with exactly one row', () => {
  // slice(0, max(1, height - 1)) kept one line and then pushed the "…more"
  // marker, so a one-row budget produced two rows.
  const state = baseState();
  state.height = 1;
  state.groups.ready = Array.from({ length: 30 }, (_, i) => t(`t-${i}`));
  assert.equal(renderBoard(state).split('\n').length, 1);
});

test('composeFrame writes exactly the rows gather() reserved', () => {
  // height = rows - 2, plus the blank and the footer, must equal `rows`. One
  // more physical line than that is what scrolls the pane.
  const terminalRows = 10;
  const state = baseState();
  state.width = 40;
  state.height = terminalRows - 2;
  state.groups.ready = Array.from({ length: 40 }, (_, i) => t(`t-${i}`));
  const frame = composeFrame(renderBoard(state), boardFooter(3000, 40));
  assert.equal(frame.split('\n').length, terminalRows, 'the frame fills the pane exactly, never past it');
});

test('truncation holds against a width oracle that is not displayWidth', () => {
  // Every other cell assertion asks displayWidth whether displayWidth was
  // right. Flags are a known quantity — two terminal cells each, one grapheme
  // cluster each — so counting the surviving clusters bounds the real width
  // without consulting the helper under test.
  const state = baseState();
  state.width = 40;
  state.repoRoot = '/repo';
  state.groups.ready = [t('t-flag', { title: '🇺🇸'.repeat(40) })];
  const row = renderBoard(state).split('\n').find((line) => line.includes('t-flag'))
    .replace(/\x1b\[[0-9;]*m/g, '');
  const flags = [...row.matchAll(/\p{Regional_Indicator}\p{Regional_Indicator}/gu)].length;
  const ascii = [...row].filter((ch) => ch.charCodeAt(0) < 128).length;
  assert.ok(flags > 0, 'the row must actually contain flags');
  assert.ok(ascii + flags * 2 <= 40, `row occupies ${ascii + flags * 2} real cells: ${row}`);
});

test('the header keeps its fields under a wide-character root', () => {
  const state = baseState();
  state.width = 60;
  state.repoRoot = `/Users/開発/${'プロジェクト'.repeat(4)}/repo`;
  const header = headerOf(state);
  assert.ok(header.includes('t-b'), `ticket lost: ${header}`);
  assert.ok(header.includes('P4'), `phase lost: ${header}`);
  assert.ok(displayWidth(header) <= 60, `header occupies ${displayWidth(header)} cells: ${header}`);
});

test('elision never splits a surrogate pair', () => {
  // The elision slices by offset. Slicing code UNITS can cut an astral
  // character in half and render a replacement box where the identifying tail
  // should be. Ticket ids and paths are both free-form enough to contain one.
  const state = baseState();
  state.width = 44;
  state.repoRoot = `/tmp/${'🎫'.repeat(30)}/repo`;
  state.active = { state: 'active', id: `T-${'🎟'.repeat(20)}` };
  const header = headerOf(state);
  assert.ok(!/[\uD800-\uDFFF]/.test(header.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')),
    `no lone surrogate may survive: ${JSON.stringify(header)}`);
});

test('a canonical generated id keeps the phase and its own distinguishing tail', () => {
  // The width sweep above uses the 3-char fixture id 't-b', so it could not see
  // that a real generated id (28 chars) overflows the bare suffix and takes the
  // phase down with it. A 20-column pane cannot hold 28 chars + phase, so the id
  // elides from the FRONT: a ULID's entropy is in its tail, and the phase — two
  // characters that say where the ticket is — must never be what gets dropped.
  const id = 'T-01JXT21Q000W3GE1R70W3GE1R7'; // shape of generateTicketId()
  assert.equal(id.length, 28, 'fixture must match the real generated id length');
  for (const width of [20, 24, 28, 35, 39, 40, 60]) {
    const state = baseState();
    state.width = width;
    state.repoRoot = '/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/deep/repo';
    state.active = { state: 'active', id };
    const header = headerOf(state);
    assert.ok(header.includes('P4'), `width ${width}: phase lost — ${header}`);
    assert.ok(header.includes(id.slice(-6)), `width ${width}: id tail lost — ${header}`);
    assert.ok(header.length <= Math.max(20, width), `width ${width}: header is ${header.length}`);
  }
});

test('a long ticket id never demotes the header back to showing only the path', () => {
  // A long id inflates the suffix, which is what pushes the fit past the root
  // budget — the degradation must drop the static root, never the ticket.
  const state = baseState();
  state.width = 60;
  state.repoRoot = '/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/deep/repo';
  state.active = { state: 'active', id: 't-01kxpd8kj9h6m6dfa83y82a1z1' };
  const header = headerOf(state);
  assert.ok(header.startsWith('ADLC board'), `header keeps its identity: ${header}`);
  assert.ok(header.includes('t-01kxpd8kj9h6m6dfa83y82a1z1'), `the full id must survive: ${header}`);
  assert.ok(!header.includes('/var/folders'), 'the root yields before the ticket does');
});

test('escapes in the ticket id or phase are stripped and do not distort the fit', () => {
  const state = baseState();
  state.width = 60;
  state.repoRoot = '/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/deep/repo';
  state.active = { state: 'active', id: '\x1b]0;pwn\x07t-evil' };
  state.phase = '\x1b[31mP9';
  const raw = renderBoard(state).split('\n')[0];
  assert.ok(!raw.includes('\x1b]'), 'no OSC survives');
  assert.ok(!raw.includes('\x1b[31m'), 'no data-borne CSI survives');
  const header = headerOf(state);
  assert.ok(header.includes('t-evil'), `the ticket still renders: ${header}`);
  assert.ok(header.includes('P9'), `the phase still renders: ${header}`);
});

test('a hostile repo root cannot smuggle escapes through the elision', () => {
  const state = baseState();
  state.repoRoot = `/tmp/\x1b]0;pwn\x07${'a'.repeat(120)}\x1b[31m/repo`;
  const raw = renderBoard(state).split('\n')[0];
  assert.ok(!raw.includes('\x1b]'), 'no OSC survives');
  assert.ok(!raw.includes('\x1b[31m'), 'no data-borne CSI survives');
  assert.ok(headerOf(state).includes('t-b'), 'the ticket still survives');
});

test('renderBoard renders calm empty states', () => {
  const out = renderBoard({
    width: 80, repoRoot: '/repo', active: { state: 'absent' }, phase: null,
    groups: { ready: [], inFlight: [], blocked: [] }, paneRows: [], ledger: [],
  });
  assert.ok(out.includes('none'));
  assert.ok(out.toLowerCase().includes('no tickets'));
});

test('a redraw after a resize uses the CURRENT pane, not the cached one', () => {
  // gather() captures geometry with its data and that fetch is async. A
  // keypress during a resize redrew an 80-column body into a 20-column pane,
  // wrapping and scrolling until a later gather succeeded — and gather can
  // fail, pinning the stale geometry indefinitely.
  const cached = { ...baseState(), width: 80, height: 40 };
  cached.groups.ready = Array.from({ length: 30 }, (_, i) => t(`t-${i}`, { title: 'y'.repeat(100) }));

  const stale = renderBoard(cached).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(stale.some((l) => displayWidth(l) > 20), 'the cached frame really is too wide for the new pane');

  const fresh = withCurrentGeometry(cached, { columns: 20, rows: 10 });
  assert.equal(fresh.width, 20);
  assert.equal(fresh.height, 8, 'height re-derived from the current rows, less the chrome');
  for (const line of renderBoard(fresh).split('\n')) {
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(displayWidth(visible) <= 20, `line is ${displayWidth(visible)} cells: ${visible}`);
  }
});

test('withCurrentGeometry keeps cached geometry when the terminal reports none', () => {
  // A non-TTY stdout has no columns/rows; falling back to 0 would blank the board.
  const cached = { ...baseState(), width: 80, height: 40 };
  for (const geometry of [{}, { columns: undefined, rows: undefined }, { columns: 0, rows: 0 }, { columns: NaN, rows: NaN }]) {
    const fresh = withCurrentGeometry(cached, geometry);
    assert.equal(fresh.width, 80);
    assert.equal(fresh.height, 40);
  }
  assert.equal(withCurrentGeometry(null, { columns: 20 }), null, 'no cached frame yet');
});

test('renderer-owned text is ASCII, so chrome cannot wrap on any terminal', () => {
  // U+2500, U+00B7, U+2026 and the arrow hints are all East_Asian_Width
  // =AMBIGUOUS — two cells on a terminal configured for East Asian text. The
  // separator was fixed first and these were missed, which left the header,
  // every row and the footer able to overflow on exactly those terminals.
  const AMBIGUOUS = /[·…←-⇿─-╿①-⓿]/;
  const state = baseState();
  state.width = 60;
  const chrome = [
    ...renderBoard(state).split('\n'),
    boardFooter(3000, 60),
    boardFooter(3000, 20),
    boardFooter(3000, 5),
  ].map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));

  for (const line of chrome) {
    // Ticket titles are DATA and stay as authored; the fixtures here are ASCII,
    // so anything ambiguous in this output is renderer-owned.
    assert.doesNotMatch(line, AMBIGUOUS, `renderer-owned ambiguous glyph: ${JSON.stringify(line)}`);
  }
});

test('the elision marker is ASCII too, and still marks elision', () => {
  const state = baseState();
  state.width = 60;
  state.repoRoot = '/var/folders/s1/51j2xgnn0pn_gft2y7n4f7p80000gn/T/deep/repo';
  const header = renderBoard(state).split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(header, /</, 'elision must still be visible');
  assert.doesNotMatch(header, /…/, 'but not via the ambiguous-width ellipsis');
  assert.ok(header.includes('t-b'), 'and the ticket still survives');
});

test('below the layout floor, the ticket beats the label at every width', () => {
  // The sub-20 test asserted only that rows fit and fill the pane — both true
  // of a header reading "ticket " with no ticket in it. Widths 7-12 did exactly
  // that: the static label ate the pane while the id and phase it introduces
  // were dropped. Field survival is the property; fitting is the constraint.
  const id = 't-b';
  for (let width = 4; width <= 19; width += 1) {
    const state = baseState();
    state.width = width;
    state.active = { state: 'active', id };
    state.phase = 'P4';
    const header = headerOf(state);
    const context = `width ${width}: ${JSON.stringify(header)}`;
    assert.ok(displayWidth(header) <= width, `overflow — ${context}`);
    assert.ok(header.includes(id) || header.includes('<'), `the id must survive or be marked elided — ${context}`);
    assert.doesNotMatch(header, /^ticket ?$/, `the label alone is not a header — ${context}`);
  }
});

test('the phase joins the id as soon as both fit, label or no label', () => {
  const state = baseState();
  state.active = { state: 'active', id: 't-b' };
  state.phase = 'P4';
  // 't-b | P4' is eight cells, so from eight columns up both fields show.
  for (let width = 8; width <= 19; width += 1) {
    state.width = width;
    const header = headerOf(state);
    assert.match(header, /t-b/, `width ${width}: ${header}`);
    assert.match(header, /P4/, `width ${width}: ${header}`);
  }
});

test('a canonical generated id keeps its phase down to eight columns', () => {
  // The narrow-pane sweeps used the 3-char fixture 't-b', which fits whole and
  // so never reached the elide-with-phase path. A real 28-char ULID does, and
  // the label-free tier used to jump straight to an id-only elision — dropping
  // the phase at every width from 8 to 17, the exact regime it exists for.
  const id = 'T-01JXT21Q000W3GE1R70W3GE1R7';
  assert.equal(id.length, 28, 'fixture must match the real generated id length');
  for (let width = 8; width <= 19; width += 1) {
    const state = baseState();
    state.width = width;
    state.active = { state: 'active', id };
    state.phase = 'P4';
    const header = headerOf(state);
    const context = `width ${width}: ${JSON.stringify(header)}`;
    assert.match(header, /P4/, `phase lost — ${context}`);
    assert.match(header, /</, `the id must be marked elided — ${context}`);
    assert.ok(header.includes(id.slice(-2)), `the id tail must survive — ${context}`);
    assert.ok(displayWidth(header) <= width, `overflow — ${context}`);
  }
});

test('rendering formats only the rows that fit, not the whole backlog', () => {
  // renderBoard used to sanitize, segment and measure EVERY ticket row and then
  // slice to the height — about a second per redraw at ten thousand tickets,
  // repeated every three seconds. Ticket count and title length are both
  // untrusted; the per-field cap bounds one row but not their number.
  //
  // Counting title reads rather than timing: a getter makes this exact and
  // machine-independent, where a millisecond bound would need calibrating and
  // could pass for the wrong reason.
  let reads = 0;
  const spy = (id) => ({ id, get title() { reads += 1; return `title of ${id}`; } });
  const state = baseState();
  state.width = 80;
  state.height = 20;
  state.groups = { ready: Array.from({ length: 10_000 }, (_, i) => spy(`t-${i}`)), inFlight: [], blocked: [] };

  const rows = renderBoard(state).split('\n');
  assert.equal(rows.length, 20, 'the frame still fills the pane');
  assert.ok(reads <= 20, `formatted ${reads} titles for a 20-row pane`);
  assert.ok(reads > 0, 'and it did render some rows — otherwise this proves nothing');
});

test('the hidden count still reflects the whole backlog, not what was built', () => {
  // The marker is derived from section lengths now, since the hidden rows are
  // never constructed. It must still tell the operator the real total.
  const state = baseState();
  state.width = 80;
  state.height = 10;
  state.groups = { ready: Array.from({ length: 500 }, (_, i) => t(`t-${i}`)), inFlight: [], blocked: [] };
  const rows = renderBoard(state).split('\n');
  assert.equal(rows.length, 10);
  const marker = rows[rows.length - 1].replace(/\x1b\[[0-9;]*m/g, '');
  const hidden = Number(marker.match(/\.\.\.(\d+) more/)?.[1]);
  // 2 chrome + 3 section headers + 500 tickets + 2 pane rows + 2 ledger rows.
  assert.equal(hidden, (2 + 3 + 500 + 2 + 2) - 10 + 1, `marker said ${hidden}: ${marker}`);
});

test('fleet rows obey the same width, budget and ASCII rules as every other section', () => {
  // The fleet section arrived on main while this branch rewrote the renderer.
  // Merging it in unchanged would have reintroduced exactly what was removed:
  // code-unit truncation, formatting past the height budget, and an
  // ambiguous-width middle dot that occupies two cells on an East Asian
  // terminal. It goes through push()/cut() like everything else.
  const state = baseState();
  state.width = 40;
  state.fleetRows = [
    { ticketId: 't-fleet-1', state: 'merged' },
    { ticketId: '日本語のチケット'.repeat(4), state: '完了' },
  ];
  const lines = renderBoard(state).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

  assert.ok(lines.some((l) => l.includes('fleet')), 'the fleet header must render');
  assert.ok(lines.some((l) => l.includes('t-fleet-1')), 'and its rows');
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 40, `fleet row exceeds the pane: ${line}`);
    // NB: the fleet row keeps '·' — pinned by the t-herdr-9 rail. It is the one
    // renderer-owned ambiguous glyph left, documented in board-render.mjs.
  }
});

test('fleet rows are counted in the hidden total and cut off at the budget', () => {
  // plannedRows is derived, not measured, so a section it forgets is a section
  // whose rows are silently missing from the "N more" count.
  const state = baseState();
  state.width = 60;
  state.height = 8;
  state.fleetRows = Array.from({ length: 30 }, (_, i) => ({ ticketId: `t-${i}`, state: 'merged' }));
  const lines = renderBoard(state).split('\n');
  assert.equal(lines.length, 8, 'the frame still fits the pane');
  const marker = lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '');
  // 2 chrome + 3 section headers + 3 tickets + 2 panes + 2 ledger + 1 fleet header + 30 fleet.
  const hidden = Number(marker.match(/\.\.\.(\d+) more/)?.[1]);
  assert.equal(hidden, (2 + 3 + 3 + 2 + 2 + 1 + 30) - 8 + 1, `marker said ${hidden}: ${marker}`);
});

test('the fleet row fits the pane even measured as ambiguous-WIDE', () => {
  // The one row whose separator the renderer cannot choose: `·` is pinned by the
  // t-herdr-9 rail, and it is ambiguous-width. Budgeting it as one cell let a
  // row that nominally filled a 37-column pane occupy 38 physical cells and
  // wrap. The oracle here is deliberately the OPPOSITE mode from the one the
  // renderer is running in — measuring with the same assumption the code used
  // is what let this through the first time.
  for (const width of [30, 37, 40, 60, 80]) {
    const state = baseState();
    state.width = width;
    state.fleetRows = [{ ticketId: 'T-01JXT21Q000W3GE1R70W3GE1R7', state: 'failed' }];
    const row = renderBoard(state).split('\n')
      .find((l) => l.includes('T-01JX'))
      ?.replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(row, `width ${width}: the fleet row must render`);
    assert.ok(
      displayWidth(row, { ambiguousWide: true }) <= width,
      `width ${width}: ${displayWidth(row, { ambiguousWide: true })} real cells on an ambiguous-wide terminal: ${row}`,
    );
  }
});

test('frameGeometry reserves the chrome rows and floors the body at one', () => {
  // The mutation gate caught this arithmetic living untested in bin/board.mjs:
  // Math.max(1, rows - 2) -> Math.max(2, ...) survived, because nothing observed
  // the floor. It matters at 1-3 rows, where the floor is what keeps a body row
  // for the header while composeFrame sheds the chrome around it.
  assert.deepEqual(frameGeometry({ columns: 100, rows: 24 }), { width: 100, height: 22 });
  for (const rows of [1, 2, 3]) {
    assert.equal(frameGeometry({ rows }).height, 1, `rows ${rows}: the body floor is one, not two`);
  }
  assert.equal(frameGeometry({ rows: 4 }).height, 2, 'and above the floor it is rows - 2');
});

test('frameGeometry falls back to 80 columns when the terminal reports none', () => {
  // `columns ?? 80` -> `?? 81` also survived. A non-TTY stdout reports no
  // columns, which is every piped or redirected run.
  for (const columns of [undefined, null, 0, -5, NaN]) {
    assert.equal(frameGeometry({ columns }).width, 80, `${JSON.stringify(columns)} must fall back to 80`);
  }
  assert.equal(frameGeometry({ columns: 120 }).width, 120, 'a real width is used as-is');
});

test('frameGeometry reports no height when the terminal reports no rows', () => {
  // null height means "do not clamp" — a piped run must not be truncated to
  // some invented number of lines.
  for (const rows of [undefined, null, 0, -1, NaN]) {
    assert.equal(frameGeometry({ rows }).height, null, `${JSON.stringify(rows)} must not clamp`);
  }
  assert.deepEqual(frameGeometry(), { width: 80, height: null }, 'and no argument at all is safe');
});
