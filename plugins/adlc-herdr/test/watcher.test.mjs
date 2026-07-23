// t-herdr-2 verification: the watcher's logic surface, with the herdr CLI
// mocked behind lib/herdr.mjs and real temp-dir fixtures for `.adlc/` reads.
// The daemon loop in bin/watcher.mjs stays thin; everything decision-shaped
// lives in lib/adlc-state.mjs and lib/tokens.mjs and is pinned here.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readActiveTicket, readLatestPhase, backlogCounts, ticketsFromExport } from '../lib/adlc-state.mjs';
import {
  paneTokens, workspaceTokens, buildReportArgs, diffPublishes, versionGate,
  droppedKeys, buildPaneClearArgs, buildWorkspaceClearArgs,
} from '../lib/tokens.mjs';

let repo;
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'adlc-herdr-test-')); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

const writeAdlc = (rel, content) => {
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  writeFileSync(join(repo, '.adlc', rel), content);
};

// ---- readActiveTicket ----

test('readActiveTicket: missing .adlc or pointer file is absent (fail soft)', () => {
  assert.deepEqual(readActiveTicket(repo), { state: 'absent' });
  mkdirSync(join(repo, '.adlc'), { recursive: true });
  assert.deepEqual(readActiveTicket(repo), { state: 'absent' });
});

test('readActiveTicket: malformed JSON is unreadable, never a throw', () => {
  writeAdlc('current-ticket.json', '{not json');
  assert.deepEqual(readActiveTicket(repo), { state: 'unreadable' });
});

test('readActiveTicket: pointer without a string id is unreadable', () => {
  writeAdlc('current-ticket.json', JSON.stringify({ ticketHash: 'abc' }));
  assert.deepEqual(readActiveTicket(repo), { state: 'unreadable' });
});

test('readActiveTicket: a valid pointer yields the id', () => {
  writeAdlc('current-ticket.json', JSON.stringify({ id: 't-x1', ticketHash: 'abc' }));
  assert.deepEqual(readActiveTicket(repo), { state: 'active', id: 't-x1' });
});

test('readActiveTicket: a one-character id is valid (only empty is unreadable)', () => {
  writeAdlc('current-ticket.json', JSON.stringify({ id: 'a', ticketHash: 'abc' }));
  assert.deepEqual(readActiveTicket(repo), { state: 'active', id: 'a' });
});

test('readActiveTicket: the legacy bare-string pointer resolves via the canonical reader', () => {
  writeAdlc('current-ticket.json', JSON.stringify('t-legacy'));
  assert.deepEqual(readActiveTicket(repo), { state: 'active', id: 't-legacy' });
});

// ---- readLatestPhase ----

test('readLatestPhase: missing ledger yields null', () => {
  assert.equal(readLatestPhase(repo, 't-x1'), null);
});

test('readLatestPhase: newest matching record wins; other tickets and phaseless records ignored', () => {
  writeAdlc('manifest.jsonl', [
    JSON.stringify({ ticket: 't-x1', data: { phase: 'p3' } }),
    JSON.stringify({ ticket: 't-other', data: { phase: 'p5' } }),
    JSON.stringify({ ticket: 't-x1', data: { note: 'no phase here' } }),
    JSON.stringify({ ticket: 't-x1', data: { phase: 'p4' } }),
  ].join('\n'));
  assert.equal(readLatestPhase(repo, 't-x1'), 'P4');
});

test('readLatestPhase: a torn (unparseable) trailing line is skipped, not fatal', () => {
  writeAdlc('manifest.jsonl', `${JSON.stringify({ ticket: 't-x1', data: { phase: 'p5' } })}\n{"tor`);
  assert.equal(readLatestPhase(repo, 't-x1'), 'P5');
});

// ---- backlogCounts ----

const t = (id, { completed = false, edges = [] } = {}) => ({ id, completed, edges });

test('backlogCounts: completed tickets are excluded and satisfy edges (invariant #104)', () => {
  const tickets = [
    t('t-done', { completed: true, edges: [{ to: 't-b' }] }),
    t('t-a', { edges: [{ to: 't-c' }] }),
    t('t-b'),
    t('t-c'),
  ];
  // t-b unblocked (prereq completed); t-c blocked by live t-a; t-a ready.
  assert.deepEqual(backlogCounts(tickets, null), { ready: 2, inFlight: 0, blocked: 1 });
});

test('backlogCounts: the active ticket counts as in-flight, not ready', () => {
  const tickets = [t('t-a'), t('t-b')];
  assert.deepEqual(backlogCounts(tickets, 't-a'), { ready: 1, inFlight: 1, blocked: 0 });
});

test('backlogCounts: fails soft on malformed input', () => {
  assert.deepEqual(backlogCounts(null, null), { ready: 0, inFlight: 0, blocked: 0 });
  assert.deepEqual(backlogCounts([{ junk: true }], null), { ready: 0, inFlight: 0, blocked: 0 });
});

// ---- ticketsFromExport ----
// Live-smoke lesson (2026-07-23): `adlc ticket list --json` is a projection
// WITHOUT `completed`/`edges` — backlog counts computed from it are silently
// wrong. The full source is the `store export` envelope; this pins its shape.

test('ticketsFromExport accepts the {tickets:[...]} envelope', () => {
  const tickets = [t('t-a'), t('t-b', { completed: true })];
  assert.deepEqual(ticketsFromExport({ tickets }), tickets);
});

test('ticketsFromExport fails soft (null) on anything else', () => {
  assert.equal(ticketsFromExport(null), null);
  assert.equal(ticketsFromExport({ nope: [] }), null);
  assert.equal(ticketsFromExport([t('t-a')]), null); // bare list is not the envelope
  assert.equal(ticketsFromExport({ tickets: 'not-a-list' }), null);
});

// ---- token building ----

test('paneTokens: active ticket + phase; phase key omitted when unknown', () => {
  assert.deepEqual(paneTokens({ state: 'active', id: 't-x1' }, 'P4'), { ticket: 't-x1', phase: 'P4' });
  assert.deepEqual(paneTokens({ state: 'active', id: 't-x1' }, null), { ticket: 't-x1' });
});

test('paneTokens: unreadable pointer yields an explicit unreadable token', () => {
  assert.deepEqual(paneTokens({ state: 'unreadable' }, null), { ticket: 'unreadable' });
});

test('paneTokens: absent state publishes nothing', () => {
  assert.deepEqual(paneTokens({ state: 'absent' }, null), {});
});

test('paneTokens: null or non-object state publishes nothing instead of throwing', () => {
  assert.deepEqual(paneTokens(null, null), {});
  assert.deepEqual(paneTokens('junk', 'P4'), {});
});

test('paneTokens: values are sanitized — escape injection in a ticket id is stripped', () => {
  const hostile = { state: 'active', id: '\x1b]0;pwn\x07t-x1\x1b[31m' };
  assert.deepEqual(paneTokens(hostile, null), { ticket: 't-x1' });
});

test('workspaceTokens renders backlog counts as single sanitized tokens', () => {
  assert.deepEqual(
    workspaceTokens({ ready: 3, inFlight: 1, blocked: 2 }),
    { adlc_ready: '3', adlc_active: '1', adlc_blocked: '2' },
  );
});

// ---- publish planning ----

test('buildReportArgs emits a single batched report-metadata argv with TTL', () => {
  const args = buildReportArgs('w1:p2', { ticket: 't-x1', phase: 'P4' }, 90_000);
  assert.deepEqual(args, [
    'pane', 'report-metadata', 'w1:p2', '--source', 'adlc',
    '--token', 'ticket=t-x1', '--token', 'phase=P4', '--ttl-ms', '90000',
  ]);
});

test('buildReportArgs never emits report-agent (agent state belongs to herdr built-ins)', () => {
  const args = buildReportArgs('w1:p2', { ticket: 't-x1' }, 90_000);
  assert.ok(!args.includes('report-agent'));
  assert.equal(args[1], 'report-metadata');
});

test('diffPublishes returns only new or changed pane token sets', () => {
  const prev = new Map([['w1:p1', { ticket: 't-a' }], ['w1:p2', { ticket: 't-b' }]]);
  const next = new Map([['w1:p1', { ticket: 't-a' }], ['w1:p2', { ticket: 't-b', phase: 'P5' }], ['w1:p3', { ticket: 't-c' }]]);
  assert.deepEqual([...diffPublishes(prev, next).keys()].sort(), ['w1:p2', 'w1:p3']);
});

test('diffPublishes with identical maps publishes nothing (change-driven, not periodic spam)', () => {
  const same = new Map([['w1:p1', { ticket: 't-a', phase: 'P4' }]]);
  assert.equal(diffPublishes(same, new Map(same)).size, 0);
});

test('droppedKeys finds entries present in prev but gone from next', () => {
  const prev = new Map([['w1:p1', {}], ['w1:p2', {}], ['w1:p3', {}]]);
  const next = new Map([['w1:p1', {}], ['w1:p3', {}]]);
  assert.deepEqual(droppedKeys(prev, next), ['w1:p2']);
  assert.deepEqual(droppedKeys(next, next), []);
});

test('clear args target only this plugin source and clear every published token key', () => {
  assert.deepEqual(buildPaneClearArgs('w1:p2'), [
    'pane', 'report-metadata', 'w1:p2', '--source', 'adlc', '--clear-token', 'ticket', '--clear-token', 'phase',
  ]);
  assert.deepEqual(buildWorkspaceClearArgs('w1'), [
    'workspace', 'report-metadata', 'w1', '--source', 'adlc',
    '--clear-token', 'adlc_ready', '--clear-token', 'adlc_active', '--clear-token', 'adlc_blocked',
  ]);
});

// ---- version gate ----

test('versionGate: at or below the tested ceiling is supported', () => {
  assert.deepEqual(versionGate('herdr 0.7.4', '0.7.4'), { supported: true });
  assert.deepEqual(versionGate('herdr 0.7.3', '0.7.4'), { supported: true });
});

test('versionGate: newer than the ceiling degrades to a single warning token', () => {
  const res = versionGate('herdr 0.8.0', '0.7.4');
  assert.equal(res.supported, false);
  assert.ok(res.token.includes('untested'));
  assert.ok(res.token.includes('0.8.0'));
});

test('versionGate: unparseable version output degrades (fail closed to the warning)', () => {
  const res = versionGate('something weird', '0.7.4');
  assert.equal(res.supported, false);
  assert.ok(res.token.includes('untested'));
});

test('versionGate: a non-semver ceiling throws a clear TypeError, not an unguarded null.slice', () => {
  assert.throws(() => versionGate('herdr 0.7.4', 'not-a-version'), TypeError);
  assert.throws(() => versionGate('herdr 0.7.4', null), TypeError);
});
