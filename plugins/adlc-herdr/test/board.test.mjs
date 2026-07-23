// t-herdr-4 verification: the board's logic surface. bin/board.mjs is thin
// TUI glue (probed 2026-07-23: overlay panes are real PTYs with pane ids and
// close when the process exits); everything decision-shaped is pinned here.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupBacklog, readLedgerTail, readTicketsViaExport } from '../lib/adlc-state.mjs';
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

test('readLedgerTail yields [] for a missing ledger or non-positive n', () => {
  assert.deepEqual(readLedgerTail(repo, 5), []);
  writeAdlc('manifest.jsonl', JSON.stringify({ seq: 1 }));
  assert.deepEqual(readLedgerTail(repo, 0), []);
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

test('renderBoard pins the width floor at 20', () => {
  const state = baseState();
  state.width = 5; // below the floor — clamp must land exactly on 20
  state.groups.ready = [t('t-long', { title: 'y'.repeat(100) })];
  const lines = renderBoard(state).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(lines.every((l) => l.length <= 20));
  assert.ok(lines.some((l) => l.length === 20), 'content must fill exactly to the 20-col floor');
});

test('renderBoard renders calm empty states', () => {
  const out = renderBoard({
    width: 80, repoRoot: '/repo', active: { state: 'absent' }, phase: null,
    groups: { ready: [], inFlight: [], blocked: [] }, paneRows: [], ledger: [],
  });
  assert.ok(out.includes('none'));
  assert.ok(out.toLowerCase().includes('no tickets'));
});
