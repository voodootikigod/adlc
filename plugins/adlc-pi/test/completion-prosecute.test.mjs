// completion-prosecute.test.mjs — AC4 (TICKET-DONE / TICKET-BLOCKED listener)
// plus the adlc_prosecute tool wiring (registration + fail-closed execute),
// driven through the real handlers under `node --test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAssistantText,
  detectCompletion,
  makeCompletionListener,
} from '../lib/completion.mjs';
import { makeProsecuteExecute, registerProsecuteTool } from '../lib/prosecute-tool.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtension } from '../lib/extension.mjs';

// --- helpers -------------------------------------------------------------

function assistant(text) {
  return { message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

function fakeCtx() {
  const notices = [];
  return { ui: { notify(msg, level) { notices.push({ msg, level }); } }, notices };
}

function fakePi() {
  const sent = [];
  return {
    sent,
    sendMessage(message, options) { sent.push({ message, options }); },
  };
}

// =========================================================================
// detectCompletion — the pure classifier
// =========================================================================

test('detectCompletion: end-anchored TICKET-DONE only', () => {
  assert.deepEqual(detectCompletion('all done.\nTICKET-DONE'), { kind: 'done' });
  assert.deepEqual(detectCompletion('TICKET-DONE\n  '), { kind: 'done' });
  assert.equal(detectCompletion('TICKET-DONE is the protocol token we look for'), null,
    'a mid-text mention is not a completion signal');
  assert.equal(detectCompletion('the work is TICKET-DONExyz'), null, 'token must be bounded');
});

test('detectCompletion: TICKET-BLOCKED captures the reason', () => {
  assert.deepEqual(detectCompletion('TICKET-BLOCKED: rail frozen, cannot edit'),
    { kind: 'blocked', reason: 'rail frozen, cannot edit' });
  assert.deepEqual(detectCompletion('progress...\nTICKET-BLOCKED: missing fixture'),
    { kind: 'blocked', reason: 'missing fixture' });
});

test('extractAssistantText: ignores non-assistant messages and joins text parts', () => {
  assert.equal(extractAssistantText({ role: 'user', content: 'hi' }), '');
  assert.equal(extractAssistantText({ role: 'assistant', content: 'plain' }), 'plain');
  assert.equal(
    extractAssistantText({ role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'toolCall' }, { type: 'text', text: 'b' }] }),
    'ab'
  );
});

// =========================================================================
// AC4 — the message_end listener
// =========================================================================

test('AC4: TICKET-DONE fires exactly one notify + one followUp + one evidence entry', async () => {
  const pi = fakePi();
  const events = [];
  const listener = makeCompletionListener({
    pi,
    getActive: () => ({ ticketId: 'T7' }),
    note: (evt) => events.push(evt),
  });
  const ctx = fakeCtx();

  await listener.onMessageEnd(assistant('Implemented it.\nTICKET-DONE'), ctx);

  assert.equal(ctx.notices.length, 1, 'one notify');
  assert.equal(pi.sent.length, 1, 'one sendMessage');
  assert.equal(pi.sent[0].options.deliverAs, 'followUp', 'delivered as a followUp nudge');
  assert.match(pi.sent[0].message.content, /adlc_prosecute/, 'nudges the prosecute tool');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ticket-done-claimed');
  assert.equal(events[0].detail.ticketId, 'T7');
});

test('AC4: a message merely CONTAINING the token does NOT fire', async () => {
  const pi = fakePi();
  const events = [];
  const listener = makeCompletionListener({ pi, getActive: () => ({ ticketId: 'T7' }), note: (e) => events.push(e) });
  const ctx = fakeCtx();
  await listener.onMessageEnd(assistant('The protocol token is TICKET-DONE, which I will emit later.'), ctx);
  assert.equal(ctx.notices.length, 0);
  assert.equal(pi.sent.length, 0);
  assert.equal(events.length, 0);
});

test('AC4: at most once per turn; resetTurn re-arms it', async () => {
  const pi = fakePi();
  const events = [];
  const listener = makeCompletionListener({ pi, getActive: () => ({ ticketId: 'T7' }), note: (e) => events.push(e) });
  const ctx = fakeCtx();

  await listener.onMessageEnd(assistant('TICKET-DONE'), ctx);
  await listener.onMessageEnd(assistant('TICKET-DONE'), ctx); // same turn — suppressed
  assert.equal(events.length, 1, 'second message in the same turn does not re-fire');

  listener.resetTurn();
  await listener.onMessageEnd(assistant('TICKET-DONE'), ctx);
  assert.equal(events.length, 2, 'a new turn re-arms the listener');
});

test('AC4: TICKET-BLOCKED records the reason as ticket-blocked (no followUp)', async () => {
  const pi = fakePi();
  const events = [];
  const listener = makeCompletionListener({ pi, getActive: () => ({ ticketId: 'T7' }), note: (e) => events.push(e) });
  const ctx = fakeCtx();

  await listener.onMessageEnd(assistant('TICKET-BLOCKED: the rail is frozen'), ctx);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ticket-blocked');
  assert.equal(events[0].detail.reason, 'the rail is frozen');
  assert.equal(pi.sent.length, 0, 'no prosecution nudge on a blocked ticket');
  assert.equal(ctx.notices.length, 1);
  assert.equal(ctx.notices[0].level, 'warning');
});

test('AC4: the listener never rewrites the message (returns undefined)', async () => {
  const listener = makeCompletionListener({ pi: fakePi(), getActive: () => ({ ticketId: 'T7' }), note: () => {} });
  const ret = await listener.onMessageEnd(assistant('TICKET-DONE'), fakeCtx());
  assert.equal(ret, undefined);
});

// =========================================================================
// adlc_prosecute tool — registration + fail-closed execute
// =========================================================================

test('registerProsecuteTool: registers adlc_prosecute with a base/ticket schema', async () => {
  const registered = [];
  const pi = { registerTool(def) { registered.push(def); } };
  // Fake TypeBox so the wiring runs under node --test (real typebox is a
  // pi-runtime-only peer, unresolvable here).
  const fakeType = {
    Object: (props) => ({ kind: 'object', props }),
    Optional: (s) => ({ kind: 'optional', s }),
    String: (o) => ({ kind: 'string', o }),
  };
  const ok = await registerProsecuteTool(
    pi,
    { getActive: () => ({ ticketId: 'T1', ticket: { id: 'T1' } }), getCwd: () => process.cwd() },
    { loadTypebox: async () => fakeType }
  );
  assert.equal(ok, true);
  assert.equal(registered.length, 1);
  const def = registered[0];
  assert.equal(def.name, 'adlc_prosecute');
  assert.equal(def.parameters.kind, 'object');
  assert.ok('base' in def.parameters.props && 'ticket' in def.parameters.props);
  assert.equal(typeof def.execute, 'function');
  assert.ok(def.promptGuidelines[0].includes('adlc_prosecute'), 'guideline names the tool, not "this tool"');
});

test('registerProsecuteTool: a missing registerTool degrades to false, no throw', async () => {
  const ok = await registerProsecuteTool({}, {}, { loadTypebox: async () => ({}) });
  assert.equal(ok, false);
});

test('execute: fail-closed deny when the enforcement context is broken', async () => {
  const execute = makeProsecuteExecute({
    pi: { async exec() { return { stdout: '' }; } },
    getActive: () => ({ ticketId: 'T404', ticket: null, error: 'active ticket "T404" not found' }),
    getCwd: () => process.cwd(),
  });
  await assert.rejects(() => execute('tc', {}, undefined, undefined, {}), /ADLC Locked/);
});

// A fake git that resolves rev-parse to a sha and returns an empty diff. Records
// every argv so a test can assert exactly what reached `git`.
function fakeGit({ diff = '' } = {}) {
  const calls = [];
  return {
    calls,
    async exec(cmd, args) {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return { stdout: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n', code: 0 };
      }
      if (cmd === 'git' && args[0] === 'merge-base') return { stdout: 'abc1234\n', code: 0 };
      if (cmd === 'git' && args[0] === 'diff') return { stdout: diff, code: 0 };
      return { stdout: '', code: 0 };
    },
  };
}

test('execute: empty diff (base=HEAD) returns CLEAN without spawning a runner', async () => {
  let spawned = false;
  const pi = fakeGit({ diff: '' });
  const execute = makeProsecuteExecute({
    pi,
    getActive: () => ({ ticketId: 'T1', ticket: { id: 'T1', title: 't' } }),
    getCwd: () => process.cwd(),
    runLensFactory: () => async () => { spawned = true; return '[]'; },
  });
  const result = await execute('tc', { base: 'HEAD' }, undefined, undefined, {});
  assert.equal(result.isError, false);
  assert.equal(result.details.verdict, 'CLEAN');
  assert.equal(result.details.rounds, 0);
  assert.equal(spawned, false, 'no lens child on an empty diff');
  assert.match(result.content[0].text, /CLEAN/);
});

test('F1: an option-shaped base ref is refused before it reaches git (no arbitrary --output write)', async () => {
  const pi = fakeGit({ diff: '' });
  const execute = makeProsecuteExecute({
    pi,
    getActive: () => ({ ticketId: 'T1', ticket: { id: 'T1', title: 't' } }),
    getCwd: () => process.cwd(),
    runLensFactory: () => async () => '[]',
  });
  // The attack: base='--output=<path>' would make `git diff` truncate a file.
  await assert.rejects(
    () => execute('tc', { base: '--output=test/contracts/frozen.test.ts' }, undefined, undefined, {}),
    /refusing suspicious base ref/
  );
  // Crucially, `git diff` was NEVER invoked with the poisoned arg.
  assert.ok(
    !pi.calls.some((c) => c[0] === 'git' && c[1] === 'diff' && c.some((a) => String(a).startsWith('--output'))),
    'no git diff carried the --output payload'
  );
});

test('F1: a plausible-but-unresolvable base ref is rejected', async () => {
  const pi = {
    calls: [],
    async exec(cmd, args) {
      this.calls.push([cmd, ...args]);
      if (args[0] === 'rev-parse') return { stdout: '', code: 1 }; // does not resolve
      return { stdout: '', code: 0 };
    },
  };
  const execute = makeProsecuteExecute({
    pi,
    getActive: () => ({ ticketId: 'T1', ticket: { id: 'T1', title: 't' } }),
    getCwd: () => process.cwd(),
    runLensFactory: () => async () => '[]',
  });
  await assert.rejects(
    () => execute('tc', { base: 'no-such-ref' }, undefined, undefined, {}),
    /does not resolve to a commit/
  );
});

test('F1: a valid base ref resolves to a sha and diffs with a -- pathspec terminator', async () => {
  const pi = fakeGit({ diff: '' });
  const execute = makeProsecuteExecute({
    pi,
    getActive: () => ({ ticketId: 'T1', ticket: { id: 'T1', title: 't' } }),
    getCwd: () => process.cwd(),
    runLensFactory: () => async () => '[]',
  });
  await execute('tc', { base: 'main' }, undefined, undefined, {});
  const diffCall = pi.calls.find((c) => c[0] === 'git' && c[1] === 'diff');
  assert.ok(diffCall, 'git diff ran');
  assert.equal(diffCall[diffCall.length - 1], '--', 'diff ends with the pathspec terminator');
  assert.ok(/^[0-9a-f]{7,40}$/.test(diffCall[2]), 'base arg is the resolved sha, not raw model text');
});

// =========================================================================
// End-to-end wiring: the message_end handler is registered on the real
// extension and reset by turn_start (booted through the fake pi harness).
// =========================================================================

test('AC4 wiring: message_end is registered on the extension and fires the followUp', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-msgend-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(
    join(root, '.adlc', 'tickets.json'),
    JSON.stringify({ tickets: [{ id: 'T1', title: 'x', body: 'b', scope: ['src/**'], rails: [] }] }, null, 2)
  );
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  try {
    const handlers = {};
    const sent = [];
    const pi = {
      on(name, fn) { handlers[name] = fn; },
      registerCommand() {},
      registerMessageRenderer() {},
      registerTool() {},
      appendEntry() {},
      sendMessage(message, options) { sent.push({ message, options }); },
      async exec() { return { stdout: '', stderr: '', code: 0 }; },
    };
    createExtension({ env: {} })(pi);
    const ctx = { cwd: root, ui: { setStatus() {}, notify() {} } };
    await handlers.session_start({ type: 'session_start' }, ctx);

    assert.equal(typeof handlers.message_end, 'function', 'message_end handler registered');
    await handlers.message_end(
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done\nTICKET-DONE' }] } },
      ctx
    );
    assert.equal(sent.length, 1, 'the TICKET-DONE followUp was sent through pi.sendMessage');
    assert.equal(sent[0].options.deliverAs, 'followUp');

    // turn_start re-arms; a second identical message after it fires again.
    await handlers.turn_start({ type: 'turn_start' }, ctx);
    await handlers.message_end(
      { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'TICKET-DONE' }] } },
      ctx
    );
    assert.equal(sent.length, 2, 'a new turn re-arms the once-per-turn listener');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
