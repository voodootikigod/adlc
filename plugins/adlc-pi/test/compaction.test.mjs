// compaction.test.mjs — T27 AC4: post-compaction ADLC-state re-assertion.
// The pure digest builder (bounded, unresolved-only) plus the session_compact
// wiring driven through the real extension with a fake sessionManager.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCompactionDigest,
  extractGateEvents,
  readSessionEntries,
  makeCompactionListener,
} from '../lib/compaction.mjs';
import { createExtension } from '../lib/extension.mjs';

// A pi CustomEntry as appendEntry('adlc-gate-event', payload) persists it.
function gateEntry(data, id = String(Math.random())) {
  return { type: 'custom', id, parentId: null, timestamp: '', customType: 'adlc-gate-event', data };
}
function otherEntry() {
  return { type: 'custom', id: 'x', parentId: null, timestamp: '', customType: 'something-else', data: { type: 'noise' } };
}
function messageEntry() {
  return { type: 'message', id: 'm', parentId: null, timestamp: '', message: { role: 'assistant', content: 'hi' } };
}

// =========================================================================
// extractGateEvents — pull only our custom entries' payloads
// =========================================================================

test('extractGateEvents: returns only adlc-gate-event payloads, in order', () => {
  const entries = [
    messageEntry(),
    gateEntry({ type: 'rail-deny', path: 'test/frozen.ts' }),
    otherEntry(),
    gateEntry({ type: 'adlc-gate-run', gate: 'preflight', code: 0 }),
  ];
  const events = extractGateEvents(entries);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'rail-deny');
  assert.equal(events[1].type, 'adlc-gate-run');
});

test('extractGateEvents: tolerates null/empty', () => {
  assert.deepEqual(extractGateEvents(null), []);
  assert.deepEqual(extractGateEvents([]), []);
});

// =========================================================================
// buildCompactionDigest — fires on unresolved events only, bounded
// =========================================================================

test('AC4: no ADLC events → no digest (null)', () => {
  assert.equal(buildCompactionDigest({ entries: [messageEntry(), otherEntry()], degraded: true, ticketId: 'T1' }), null);
});

test('AC4: only informational events (pass rows, unvetted, done) → no digest', () => {
  const entries = [
    gateEntry({ type: 'adlc-gate-run', gate: 'preflight', code: 0 }),
    gateEntry({ type: 'unvetted-tool', tool: 'search' }),
    gateEntry({ type: 'ticket-done-claimed' }),
    gateEntry({ type: 'prosecute-run', verdict: 'CLEAN' }),
  ];
  assert.equal(buildCompactionDigest({ entries, degraded: false, ticketId: 'T1' }), null);
});

test('AC4: unresolved denies/reverts → a digest naming the active ticket, degraded flag, and events', () => {
  const entries = [
    gateEntry({ type: 'rail-deny', path: 'test/contracts/frozen.test.ts', reason: 'frozen rail' }),
    gateEntry({ type: 'adlc-gate-run', gate: 'preflight', code: 0 }), // informational, excluded from list
    gateEntry({ type: 'suppression-revert', markers: ['x'], path: 'src/a.ts' }),
    gateEntry({ type: 'user-bash-rail-override', command: 'rm x', reason: 'human override' }),
  ];
  const digest = buildCompactionDigest({ entries, degraded: true, ticketId: 'T7' });
  assert.ok(digest);
  assert.match(digest, /Active ticket: T7/);
  assert.match(digest, /DEGRADED/);
  assert.match(digest, /rail-deny test\/contracts\/frozen.test.ts/);
  assert.match(digest, /suppression-revert/);
  assert.match(digest, /user-bash-rail-override/);
  assert.doesNotMatch(digest, /adlc-gate-run/, 'informational pass rows are not re-asserted');
});

test('AC4: ticket-blocked is treated as unresolved state', () => {
  const digest = buildCompactionDigest({ entries: [gateEntry({ type: 'ticket-blocked', reason: 'need creds' })], ticketId: 'T1' });
  assert.ok(digest);
  assert.match(digest, /ticket-blocked/);
});

test('AC4: manual compaction (degraded false) still fires when unresolved events exist, without the DEGRADED line', () => {
  const digest = buildCompactionDigest({ entries: [gateEntry({ type: 'rail-deny', path: 'p' })], degraded: false, ticketId: 'T1' });
  assert.ok(digest);
  assert.doesNotMatch(digest, /DEGRADED/);
});

test('AC4: digest is bounded to the last 10 events and ≤ 1200 chars', () => {
  const entries = [];
  for (let i = 0; i < 40; i++) {
    entries.push(gateEntry({ type: 'rail-deny', path: `test/contracts/file-${i}-with-a-fairly-long-name.test.ts`, reason: 'frozen rail hit with a verbose explanatory reason string that pads length' }));
  }
  const digest = buildCompactionDigest({ entries, degraded: true, ticketId: 'T1' });
  assert.ok(digest.length <= 1200, `bounded length: ${digest.length}`);
  // The last 10 events are listed newest-first (count line reflects the cap).
  assert.match(digest, /Unresolved enforcement events \(10 of 40, newest first\)/);
  assert.match(digest, /file-39-/, 'the newest event survives the char cap');
  assert.doesNotMatch(digest, /file-29-/, 'the 11th-newest is outside the 10-event window');
});

// =========================================================================
// makeCompactionListener — sends exactly one nextTurn message when it fires
// =========================================================================

test('AC4 wiring: sends exactly one nextTurn digest when unresolved events exist', async () => {
  const sent = [];
  const pi = { sendMessage(message, options) { sent.push({ message, options }); } };
  const listener = makeCompactionListener({
    pi,
    getActive: () => ({ ticketId: 'T1' }),
    getEntries: () => [gateEntry({ type: 'rail-deny', path: 'p' })],
    isDegraded: () => true,
  });
  await listener({ type: 'session_compact', reason: 'threshold' }, {});
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, 'adlc-state-reassertion');
  assert.equal(sent[0].options.deliverAs, 'nextTurn');
  assert.equal(sent[0].message.details.ticketId, 'T1');
});

test('AC4 wiring: sends nothing when there are no unresolved events', async () => {
  const sent = [];
  const pi = { sendMessage(m, o) { sent.push({ m, o }); } };
  const listener = makeCompactionListener({
    pi,
    getActive: () => ({ ticketId: 'T1' }),
    getEntries: () => [gateEntry({ type: 'adlc-gate-run', gate: 'preflight', code: 0 })],
    isDegraded: () => true,
  });
  await listener({ type: 'session_compact', reason: 'manual' }, {});
  assert.equal(sent.length, 0);
});

test('AC4 wiring: a sendMessage failure never throws into the compact handler', async () => {
  const pi = { sendMessage() { throw new Error('stream busy'); } };
  const listener = makeCompactionListener({
    pi,
    getActive: () => ({ ticketId: 'T1' }),
    getEntries: () => [gateEntry({ type: 'rail-deny', path: 'p' })],
    isDegraded: () => false,
  });
  await assert.doesNotReject(() => listener({ type: 'session_compact', reason: 'manual' }, {}));
});

test('readSessionEntries: prefers getBranch, falls back to getEntries, tolerates absence', () => {
  assert.deepEqual(readSessionEntries({ sessionManager: { getBranch: () => ['b'], getEntries: () => ['e'] } }), ['b']);
  assert.deepEqual(readSessionEntries({ sessionManager: { getEntries: () => ['e'] } }), ['e']);
  assert.deepEqual(readSessionEntries({}), []);
  assert.deepEqual(readSessionEntries(null), []);
});

// =========================================================================
// End-to-end: session_compact is wired on the real extension and re-asserts
// from the session's own recorded gate events (fake sessionManager).
// =========================================================================

test('AC4 e2e: session_compact on the extension sends a nextTurn digest built from recorded gate events', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-compact-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(
    join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'x', body: 'b', scope: ['src/**'], rails: ['test/contracts/**'] }] }, null, 2)
  );
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  try {
    const handlers = {};
    const sent = [];
    // The session records entries via appendEntry; the fake sessionManager
    // replays them to getBranch() so the re-assertion reads real recorded state.
    const sessionEntries = [];
    const pi = {
      on(name, fn) { handlers[name] = fn; },
      registerCommand() {},
      registerMessageRenderer() {},
      registerTool() {},
      appendEntry(customType, data) { sessionEntries.push({ type: 'custom', id: String(sessionEntries.length), parentId: null, timestamp: '', customType, data }); },
      sendMessage(message, options) { sent.push({ message, options }); },
      async exec() { return { stdout: '', stderr: '', code: 0 }; },
    };
    createExtension({ env: {} })(pi);
    const ctx = { cwd: root, ui: { setStatus() {}, notify() {} }, sessionManager: { getBranch: () => sessionEntries } };
    await handlers.session_start({ type: 'session_start' }, ctx);

    // Record a rail-deny into the session by driving a blocked write.
    await handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'test/contracts/frozen.test.ts', content: 'x' } },
      ctx
    );
    assert.ok(sessionEntries.some((e) => e.customType === 'adlc-gate-event' && e.data.type === 'rail-deny'), 'a rail-deny was recorded');

    assert.equal(typeof handlers.session_compact, 'function', 'session_compact handler registered');
    await handlers.session_compact({ type: 'session_compact', reason: 'threshold' }, ctx);

    const reassertion = sent.filter((s) => s.message.customType === 'adlc-state-reassertion');
    assert.equal(reassertion.length, 1, 'exactly one re-assertion digest');
    assert.equal(reassertion[0].options.deliverAs, 'nextTurn');
    assert.match(reassertion[0].message.content, /rail-deny test\/contracts\/frozen.test.ts/);
    assert.match(reassertion[0].message.content, /Active ticket: T1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
