// AC2–AC5 — drive the real extension handlers through a fake pi/ctx harness to
// prove the live widget wiring, inert-session silence, minimal-ctx crash
// safety, renderer registration, and the gate-notice message emission.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtension } from '../lib/extension.mjs';

const TICKET = {
  id: 'T24',
  title: 'Command surface',
  body: 'Do the thing',
  scope: ['src/**'],
  rails: ['test/contracts/**'],
};
const HIGH_RISK = { id: 'T7', title: 'Dangerous', body: 'risky', risk: 'high', scope: ['src/**'], rails: ['test/contracts/**'] };

function makeRepo({ tickets = [TICKET], current = 'T24' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-widget-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (current !== null) writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  mkdirSync(join(root, 'src'), { recursive: true });
  return root;
}

function fakePi() {
  const handlers = {};
  const commands = {};
  const renderers = {};
  const messages = [];
  const entries = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    registerMessageRenderer(type, fn) { renderers[type] = fn; },
    sendMessage(msg, opts) { messages.push({ msg, opts }); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    async exec() { return { stdout: '', stderr: '', code: 0 }; },
    handlers, commands, renderers, messages, entries,
  };
}

// A full-featured ctx that captures setWidget content and serves a percent.
function fakeCtx(cwd, { percent = 12 } = {}) {
  const widgets = [];
  const notices = [];
  return {
    cwd,
    ui: {
      setStatus() {},
      notify(m, l) { notices.push({ m, l }); },
      setWidget(key, content) { widgets.push({ key, content }); },
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent }),
    widgets, notices,
  };
}

// AC4 shape: an older/RPC ctx with NO setWidget and NO getContextUsage.
function minimalCtx(cwd) {
  const notices = [];
  return { cwd, ui: { setStatus() {}, notify(m, l) { notices.push({ m, l }); } }, notices };
}

async function boot(root, { env = {}, ctx } = {}) {
  const pi = fakePi();
  createExtension({ env })(pi);
  const useCtx = ctx ?? fakeCtx(root);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, useCtx);
  return { pi, ctx: useCtx };
}

const lastWidget = (ctx) => ctx.widgets[ctx.widgets.length - 1];

// =========================================================================
// AC2 — widget refresh on session_start, rail deny, and deactivation clear
// =========================================================================

test('AC2: session_start with an active ticket sets a widget naming the ticket', async () => {
  const root = makeRepo();
  try {
    const { ctx } = await boot(root);
    const w = lastWidget(ctx);
    assert.equal(w.key, 'adlc');
    assert.ok(Array.isArray(w.content), 'content is the line array');
    assert.match(w.content[0], /T24/, 'first line names the ticket');
    assert.match(w.content[0], /\(active\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2: a rail deny refreshes the widget with the gate event', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const before = ctx.widgets.length;
    const denied = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'test/contracts/x.test.ts', content: 'x' } },
      ctx
    );
    assert.equal(denied.block, true);
    assert.ok(ctx.widgets.length > before, 'widget refreshed after the deny');
    const w = lastWidget(ctx);
    assert.ok(w.content.some((l) => l.includes('rail-deny')), `gate event present: ${JSON.stringify(w.content)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2: deactivating the ticket (pointer removed + turn_start) clears the widget', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    assert.ok(Array.isArray(lastWidget(ctx).content), 'active initially');
    // Remove the pointer, then a turn boundary re-resolves to inert.
    rmSync(join(root, '.adlc', 'current-ticket.json'));
    await pi.handlers.turn_start({ type: 'turn_start' }, ctx);
    const w = lastWidget(ctx);
    assert.equal(w.key, 'adlc');
    assert.equal(w.content, undefined, 'cleared with undefined');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2: a threshold compaction refreshes the widget with the degraded flag', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    await pi.handlers.session_compact({ type: 'session_compact', reason: 'overflow' }, ctx);
    assert.match(lastWidget(ctx).content[0], /degraded/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC3 — an inert session never renders a content-bearing widget
// =========================================================================

test('AC3: inert session (no ticket) never calls setWidget with content', async () => {
  const root = makeRepo({ current: null });
  try {
    const { pi, ctx } = await boot(root);
    await pi.handlers.turn_start({ type: 'turn_start' }, ctx);
    await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'anything.ts', content: 'x' } },
      ctx
    );
    const withContent = ctx.widgets.filter((w) => w.content !== undefined);
    assert.equal(withContent.length, 0, `no content widget in an inert session: ${JSON.stringify(ctx.widgets)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC4 — a ctx without setWidget/getContextUsage crashes no handler
// =========================================================================

test('AC4: the full deny path runs on a minimal ctx (no setWidget/getContextUsage)', async () => {
  const root = makeRepo();
  try {
    const pi = fakePi();
    createExtension({ env: {} })(pi);
    const ctx = minimalCtx(root);
    // session_start, a rail deny, and turn_start must all survive.
    await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
    const denied = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'test/contracts/x.test.ts', content: 'x' } },
      ctx
    );
    assert.equal(denied.block, true, 'the gate still blocks');
    await pi.handlers.turn_start({ type: 'turn_start' }, ctx);
    await pi.handlers.session_compact({ type: 'session_compact', reason: 'overflow' }, ctx);
    // gate-notice still emitted despite no widget surface.
    assert.ok(pi.messages.some((m) => m.msg.customType === 'adlc-gate-notice'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC5 — renderer registration + gate-notice emission alongside notify
// =========================================================================

test('AC5: both custom message renderers are registered at extension load', async () => {
  const pi = fakePi();
  createExtension({ env: {} })(pi);
  assert.equal(typeof pi.renderers['adlc-flail-advisory'], 'function');
  assert.equal(typeof pi.renderers['adlc-gate-notice'], 'function');
});

test('AC5: a rail deny emits an adlc-gate-notice message in addition to notify', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'test/contracts/x.test.ts', content: 'x' } },
      ctx
    );
    const notice = pi.messages.find((m) => m.msg.customType === 'adlc-gate-notice');
    assert.ok(notice, 'gate-notice emitted');
    assert.equal(notice.msg.display, true);
    assert.match(notice.msg.content, /rail-deny/);
    assert.equal(notice.msg.details.type, 'rail-deny');
    // The notify fallback still fired.
    assert.ok(ctx.notices.some((n) => /Blocked/.test(n.m)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC5: the build-gate deny path emits an adlc-gate-notice', async () => {
  const root = makeRepo({ tickets: [HIGH_RISK], current: 'T7' });
  try {
    // Degrade via compaction at a low percent: past the handoff band (60%) the
    // slice-5 deny-set fires first, so a high percent would exercise the
    // handoff notice rather than this one.
    const { pi, ctx } = await boot(root, { ctx: fakeCtx(realpathSync(join(root)), { percent: 10 }) });
    await pi.handlers.session_compact({ type: 'session_compact', reason: 'overflow', willRetry: true }, ctx);
    const denied = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'src/a.ts', content: 'x' } },
      ctx
    );
    assert.equal(denied.block, true);
    assert.match(denied.reason, /build gate/i);
    const notice = pi.messages.find((m) => m.msg.customType === 'adlc-gate-notice' && m.msg.details.type === 'build-gate-deny');
    assert.ok(notice, `build-gate-deny notice emitted: ${JSON.stringify(pi.messages.map((m) => m.msg.details?.type))}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC5: an advisory gate (unvetted tool) does NOT emit a gate-notice', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    // An unknown tool with no path-like arg is recorded as unvetted, not denied.
    await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'weather_lookup', toolCallId: 'c1', input: { city: 'NYC' } },
      ctx
    );
    assert.ok(!pi.messages.some((m) => m.msg.customType === 'adlc-gate-notice'), 'no notice for a non-deny event');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// #927/#936 — the session_start widget hints: P7 staleness rides the manifest
// read (fail-silent); pendingAcceptance rides this session's own branch when
// a done-claim lacks a resolving accept.
// =========================================================================

test('AC3: P7 staleness renders when manifest carries stale lesson-foundry', async () => {
  const root = makeRepo({} = {});
  try {
    // Overwrite the fixture manifest with a lesson-foundry entry old enough
    // (30 days) to cross the default 14-day threshold.
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    writeFileSync(join(root, '.adlc', 'manifest.jsonl'), JSON.stringify({ gate: 'lesson-foundry', type: 'lesson-foundry', at: old }) + '\n');
    const { ctx } = await boot(root);
    const w = lastWidget(ctx);
    assert.ok(w.content.some((l) => /P7 stale:/.test(l)), `P7 stale line rendered: ${JSON.stringify(w.content)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: manifest read failure degrades silently (no P7 hint, no error)', async () => {
  const root = makeRepo();
  try {
    // Make the manifest unreadable: a directory at the manifest path makes
    // readOwnManifestChain's legacy flat-file read throw.
    mkdirSync(join(root, '.adlc', 'manifest.jsonl'), { recursive: true });
    const { ctx } = await boot(root);
    const w = lastWidget(ctx);
    assert.ok(!w.content.some((l) => /P7 stale:/.test(l)), 'no P7 hint on unreadable manifest');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: P7 hint suppressed when lesson-foundry is fresh', async () => {
  const root = makeRepo();
  try {
    const fresh = new Date().toISOString();
    writeFileSync(join(root, '.adlc', 'manifest.jsonl'), JSON.stringify({ gate: 'lesson-foundry', type: 'lesson-foundry', at: fresh }) + '\n');
    const { ctx } = await boot(root);
    const w = lastWidget(ctx);
    assert.ok(!w.content.some((l) => /P7 stale:/.test(l)), 'fresh P7 entry → no hint');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
