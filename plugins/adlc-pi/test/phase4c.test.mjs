// T28 tests: Phase 4c — /adlc-accept human gate, session_shutdown open-ticket
// capture, and fork-based /adlc-rollback (spec 4.5 + 4.6).
//
// AC1 drives /adlc-accept through the real command handler with a fake pi.exec
// (behavior-diff + accept) and a fake confirm. AC2 drives the real
// session_shutdown listener and asserts the manifest mirror is chain-valid. AC3
// drives /adlc-rollback with a fake command ctx (sessionManager.getBranch +
// fork). All three boot the extension end-to-end (createExtension()(pi)).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtension } from '../lib/extension.mjs';
import { buildRollbackCandidates } from '../lib/rollback.mjs';
import { buildShutdownEvidence } from '../lib/shutdown.mjs';
import { verify } from '@adlc/gate-manifest/lib/verify.mjs';

const T1 = {
  id: 'T1', title: 'First ticket', body: 'Do the first thing',
  scope: ['src/**'], rails: ['test/contracts/**'], edges: [], duration: 1, category: 'feature',
};

function makeRepo({ current = 'T1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-t28-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [T1] }, null, 2));
  if (current !== null) {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  }
  return root;
}

// A fake pi recording exec calls and session appendEntry entries.
function fakePi({ exec } = {}) {
  const handlers = {};
  const commands = {};
  const entries = [];
  const execCalls = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    registerMessageRenderer() {},
    sendMessage() {},
    async exec(cmd, args) {
      execCalls.push({ cmd, args });
      if (typeof exec === 'function') return exec(cmd, args);
      return { stdout: '', stderr: '', code: 0 };
    },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    handlers, commands, entries, execCalls,
  };
}

function fakeCtx(cwd, { hasUI = true, select, confirm, sessionManager, fork } = {}) {
  const notices = [];
  const calls = { select: 0, confirm: 0, fork: 0 };
  const forkArgs = [];
  const ctx = {
    cwd,
    hasUI,
    sessionManager,
    ui: {
      setStatus() {},
      setWidget() {},
      notify(msg, level) { notices.push({ msg, level }); },
      async select(title, options) {
        calls.select += 1;
        return typeof select === 'function' ? select(title, options) : options[0];
      },
      async confirm(title, message) {
        calls.confirm += 1;
        return typeof confirm === 'function' ? confirm(title, message) : true;
      },
    },
    notices,
    calls,
    forkArgs,
  };
  if (fork !== null) {
    ctx.fork = async (entryId, options) => {
      calls.fork += 1;
      forkArgs.push({ entryId, options });
      return typeof fork === 'function' ? fork(entryId, options) : { cancelled: false };
    };
  }
  return ctx;
}

async function boot(root, { exec } = {}) {
  const pi = fakePi({ exec });
  createExtension({ env: {} })(pi);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, fakeCtx(root));
  return { pi };
}

// =========================================================================
// AC1 — /adlc-accept: happy path runs both CLIs + notifies; confirm=false runs
// behavior-diff but NOT accept; missing packet errors with no dialog, no exec.
// =========================================================================

function acceptExec(cmd, args) {
  if (args[0] === 'behavior-diff') {
    // compare exits 2 when behavior changed; still emits a structured verdict.
    return { stdout: JSON.stringify({ identical: 2, changed: 1, unreachable: 0 }), stderr: '', code: 2 };
  }
  if (args[0] === 'accept') {
    return { stdout: JSON.stringify({ ok: true, exitCode: 0, ticket: 'T1', revision: 'abcdef0123456789' }), stderr: '', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
}

function writePacket(root, { before = '.adlc/before.json', after = '.adlc/after.json', withCaptures = true } = {}) {
  if (withCaptures) {
    writeFileSync(join(root, before), JSON.stringify({ routes: [] }));
    writeFileSync(join(root, after), JSON.stringify({ routes: [] }));
  }
  const packet = withCaptures ? { ticket: 'T1', before, after } : { ticket: 'T1' };
  writeFileSync(join(root, '.adlc', 'packet.json'), JSON.stringify(packet));
  return '.adlc/packet.json';
}

test('AC1: /adlc-accept happy path (confirm=true) runs behavior-diff AND accept, then notifies the acceptance', async () => {
  const root = makeRepo();
  try {
    const { pi } = await boot(root, { exec: acceptExec });
    const packetArg = writePacket(root);
    const ctx = fakeCtx(root, { confirm: () => true });

    await pi.commands['adlc-accept'].handler(packetArg, ctx);

    const verbs = pi.execCalls.map((c) => c.args[0]);
    assert.ok(verbs.includes('behavior-diff'), 'behavior-diff compare ran');
    assert.ok(verbs.includes('accept'), 'accept ran');
    const acceptCall = pi.execCalls.find((c) => c.args[0] === 'accept');
    assert.deepEqual(
      acceptCall.args.slice(0, 5),
      ['accept', '--ticket', 'T1', '--packet', packetArg],
      'accept invoked with the resolved ticket + packet'
    );
    assert.ok(acceptCall.args.includes('--json'), 'accept requested --json');
    assert.ok(ctx.notices.some((n) => n.level === 'info' && /recorded P6 acceptance for ticket T1/.test(n.msg)));
    // The confirm summary carried the behavior-diff verdict.
    assert.ok(ctx.calls.confirm === 1, 'confirm surfaced exactly once');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1: /adlc-accept with confirm=false runs behavior-diff but NOT accept and records nothing', async () => {
  const root = makeRepo();
  try {
    const { pi } = await boot(root, { exec: acceptExec });
    const packetArg = writePacket(root);
    const ctx = fakeCtx(root, { confirm: () => false });

    await pi.commands['adlc-accept'].handler(packetArg, ctx);

    const verbs = pi.execCalls.map((c) => c.args[0]);
    assert.ok(verbs.includes('behavior-diff'), 'behavior-diff ran (feeds the confirm summary)');
    assert.ok(!verbs.includes('accept'), 'accept did NOT run after decline');
    assert.ok(ctx.notices.some((n) => /declined — nothing recorded/.test(n.msg)));
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false, 'no evidence recorded on decline');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1: /adlc-accept on a missing packet path errors with no dialog and no exec', async () => {
  const root = makeRepo();
  try {
    const { pi } = await boot(root, { exec: acceptExec });
    const ctx = fakeCtx(root, { confirm: () => true });

    await pi.commands['adlc-accept'].handler('.adlc/nope.json', ctx);

    assert.equal(ctx.calls.confirm, 0, 'no dialog opened for a missing packet');
    assert.equal(pi.execCalls.length, 0, 'no CLI invoked for a missing packet');
    assert.ok(ctx.notices.some((n) => n.level === 'error' && /cannot read acceptance packet/.test(n.msg)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1: /adlc-accept with a packet but no before/after skips behavior-diff and still accepts on approve', async () => {
  const root = makeRepo();
  try {
    const { pi } = await boot(root, { exec: acceptExec });
    const packetArg = writePacket(root, { withCaptures: false });
    const ctx = fakeCtx(root, { confirm: () => true });

    await pi.commands['adlc-accept'].handler(packetArg, ctx);

    const verbs = pi.execCalls.map((c) => c.args[0]);
    assert.ok(!verbs.includes('behavior-diff'), 'behavior-diff skipped without captures');
    assert.ok(verbs.includes('accept'), 'accept still ran on approve');
    const acceptCall = pi.execCalls.find((c) => c.args[0] === 'accept');
    assert.ok(!acceptCall.args.includes('--before'), 'no --before passed without captures');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC1: /adlc-accept in non-TUI mode notifies and aborts without running any CLI', async () => {
  const root = makeRepo();
  try {
    const { pi } = await boot(root, { exec: acceptExec });
    const packetArg = writePacket(root);
    const ctx = fakeCtx(root, { hasUI: false });

    await pi.commands['adlc-accept'].handler(packetArg, ctx);

    assert.equal(pi.execCalls.length, 0, 'no CLI run without a UI to confirm');
    assert.equal(ctx.calls.confirm, 0);
    assert.ok(ctx.notices.some((n) => /requires interactive confirmation/.test(n.msg)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC2 — session_shutdown with unresolved gate events appends a chain-valid
// manifest entry; a clean session or no active ticket appends nothing.
// =========================================================================

function gateEvent(id, type, extra = {}) {
  return { type: 'custom', customType: 'adlc-gate-event', id, parentId: null, data: { type, at: new Date().toISOString(), ...extra } };
}
function msg(id, role, text) {
  return { type: 'message', id, parentId: null, message: { role, content: text } };
}

test('buildShutdownEvidence: denies after the last pass are unresolved; a later pass clears them', () => {
  const dirty = [gateEvent('e1', 'rail-deny', { path: 'test/contracts/x.ts' })];
  assert.ok(buildShutdownEvidence({ entries: dirty, ticketId: 'T1' }), 'a bare deny is unresolved');

  const cleared = [gateEvent('e1', 'rail-deny'), gateEvent('e2', 'adlc-gate-run', { code: 0 })];
  assert.equal(buildShutdownEvidence({ entries: cleared, ticketId: 'T1' }), null, 'a later passing gate clears it');

  const reopened = [gateEvent('e1', 'adlc-gate-run', { code: 0 }), gateEvent('e2', 'bash-rail-revert', { paths: ['a'] })];
  assert.ok(buildShutdownEvidence({ entries: reopened, ticketId: 'T1' }), 'a revert after a pass reopens');

  assert.equal(buildShutdownEvidence({ entries: [], ticketId: 'T1' }), null, 'no events → nothing');
});

test('AC2: session_shutdown with unresolved denies appends a chain-valid manifest entry', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const branch = [msg('m1', 'user', 'go'), gateEvent('g1', 'rail-deny', { path: 'test/contracts/x.ts', reason: 'frozen rail' })];
    const ctx = fakeCtx(root, { sessionManager: { getBranch: () => branch } });

    await pi.handlers.session_shutdown({ type: 'session_shutdown', reason: 'quit' }, ctx);

    const manifestPath = join(root, '.adlc', 'manifest.jsonl');
    assert.ok(existsSync(manifestPath), 'manifest written on unresolved shutdown');
    assert.match(readFileSync(manifestPath, 'utf8'), /pi-session-shutdown-open-ticket/);
    const verdict = verify(join(root, '.adlc'));
    assert.equal(verdict.valid, true, `manifest chain must verify: ${JSON.stringify(verdict)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2: session_shutdown on a clean session appends nothing', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const branch = [gateEvent('g1', 'rail-deny'), gateEvent('g2', 'adlc-gate-run', { code: 0 })];
    const ctx = fakeCtx(root, { sessionManager: { getBranch: () => branch } });

    await pi.handlers.session_shutdown({ type: 'session_shutdown', reason: 'quit' }, ctx);

    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false, 'no entry for a cleared session');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC2: session_shutdown with no active ticket appends nothing', async () => {
  const root = makeRepo({ current: null });
  try {
    const { pi } = await boot(root);
    const branch = [gateEvent('g1', 'rail-deny')];
    const ctx = fakeCtx(root, { sessionManager: { getBranch: () => branch } });

    await pi.handlers.session_shutdown({ type: 'session_shutdown', reason: 'quit' }, ctx);

    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false, 'no ticket → no capture');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// AC3 — /adlc-rollback surfaces a select of entry digests and forks the chosen
// entry; select=undefined forks nothing; a sessionManager without getBranch
// degrades to a notify.
// =========================================================================

test('buildRollbackCandidates: message entries newest-first, pre-failure entries preferred', () => {
  const branch = [
    msg('m1', 'user', 'start'),
    msg('m2', 'assistant', 'editing the rail'),
    gateEvent('g1', 'rail-deny', { path: 'test/contracts/x.ts' }),
    msg('m3', 'user', 'try again'),
  ];
  const cands = buildRollbackCandidates(branch);
  assert.equal(cands[0].id, 'm2', 'the entry before the deny floats to the top');
  assert.ok(cands[0].preferred && /before rail-deny/.test(cands[0].label));
  assert.deepEqual(cands.map((c) => c.id), ['m2', 'm3', 'm1'], 'preferred first, then newest-first');
});

test('AC3: /adlc-rollback surfaces a select and forks the chosen entry, recording evidence', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const branch = [msg('m1', 'user', 'start'), msg('m2', 'assistant', 'edit'), gateEvent('g1', 'rail-deny', { path: 'x' })];
    let offered = null;
    const ctx = fakeCtx(root, {
      sessionManager: { getBranch: () => branch },
      select: (_title, options) => { offered = options; return options[0]; },
    });

    await pi.commands['adlc-rollback'].handler('', ctx);

    assert.equal(ctx.calls.select, 1, 'select surfaced');
    assert.ok(offered.length >= 1 && /before rail-deny/.test(offered[0]), 'digest labels offered');
    assert.equal(ctx.calls.fork, 1, 'fork called once');
    assert.equal(ctx.forkArgs[0].entryId, 'm2', 'forked the pre-failure entry');
    assert.match(readFileSync(join(root, '.adlc', 'manifest.jsonl'), 'utf8'), /pi-adlc-rollback/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: /adlc-rollback with select returning undefined forks nothing', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const branch = [msg('m1', 'user', 'start'), msg('m2', 'assistant', 'edit')];
    const ctx = fakeCtx(root, { sessionManager: { getBranch: () => branch }, select: () => undefined });

    await pi.commands['adlc-rollback'].handler('', ctx);

    assert.equal(ctx.calls.fork, 0, 'no fork on cancel');
    assert.ok(ctx.notices.some((n) => /cancelled/.test(n.msg)));
    assert.equal(existsSync(join(root, '.adlc', 'manifest.jsonl')), false, 'nothing recorded on cancel');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('AC3: /adlc-rollback degrades to a notify when the sessionManager lacks getBranch', async () => {
  const root = makeRepo({ current: 'T1' });
  try {
    const { pi } = await boot(root);
    const ctx = fakeCtx(root, { sessionManager: {} });

    await pi.commands['adlc-rollback'].handler('', ctx);

    assert.equal(ctx.calls.fork, 0, 'no fork when the API is unavailable');
    assert.ok(ctx.notices.some((n) => n.level === 'warning' && /rollback unavailable/.test(n.msg)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
