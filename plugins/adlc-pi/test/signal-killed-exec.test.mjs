// signal-killed-exec.test.mjs — an exec killed by a signal pi did not send.
//
// pi resolves such a child as `{ code: code ?? 0, killed: false }`: the exit
// code is null (a signal death has none) and `killed` is only set by pi's own
// timeout/abort. So `{ code: 0, killed: false, stdout: '' }` is exactly what an
// OOM-killed or externally `kill`ed gate looks like. Every adlc_gate and
// /adlc-accept run asks for `--json`, and every such command prints a JSON
// document when it completes, so exit 0 with no JSON on stdout is a run that
// produced no verdict: it must be a tool error / refusal, never a PASS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from '@adlc/core/test-kit';
import { makeGateExecute, verdictFailureReason } from '../lib/gate-tool.mjs';
import { createExtension } from '../lib/extension.mjs';

const TICKET = {
  id: 'T1', title: 'Gate tool ticket', body: 'Run gates through the tool.',
  scope: ['src/**'], rails: ['test/contracts/**'], edges: [], duration: 1, category: 'feature',
};

function makeRepo(t) {
  const root = tmp(t, 'pi-sigkill-');
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets: [TICKET] }, null, 2));
  writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: 'T1' }));
  writeFileSync(join(root, '.adlc', 'packet.json'), JSON.stringify({ ticket: 'T1' }));
  return root;
}

function gateExecute(root, result) {
  const notes = [];
  const execute = makeGateExecute({
    getActive: () => ({ ticketId: 'T1', ticket: TICKET, error: null }),
    getCwd: () => root,
    exec: async () => result,
    note: (evt) => { notes.push(evt); },
  });
  return { execute, notes };
}

const SIGNAL_KILLED = { stdout: '', stderr: '', code: 0, killed: false };

test('adlc_gate: a signal-killed exec ({code:0, killed:false, stdout:""}) throws instead of PASS', async (t) => {
  const { execute } = gateExecute(makeRepo(t), SIGNAL_KILLED);
  await assert.rejects(
    () => execute('tc', { gate: 'preflight' }, undefined, undefined, {}),
    (err) => {
      assert.match(err.message, /adlc_gate\(preflight\) failed to execute/);
      assert.match(err.message, /no JSON verdict/);
      return true;
    },
  );
});

test('adlc_gate: exit 0 with truncated (unparseable) stdout is not a verdict either', async (t) => {
  const { execute } = gateExecute(makeRepo(t), { stdout: '{"ok": tr', stderr: '', code: 0, killed: false });
  await assert.rejects(() => execute('tc', { gate: 'preflight' }, undefined, undefined, {}), /no JSON verdict/);
});

test('adlc_gate: a signal-killed exec leaves no state-resolving adlc-gate-run entry', async (t) => {
  const { execute, notes } = gateExecute(makeRepo(t), SIGNAL_KILLED);
  await assert.rejects(() => execute('tc', { gate: 'preflight' }, undefined, undefined, {}));
  assert.equal(notes.length, 0);
});

test('adlc_gate: exit 0 with a JSON document is still a PASS and is recorded', async (t) => {
  const { execute, notes } = gateExecute(makeRepo(t), { stdout: '{"ok":true}', stderr: '', code: 0 });
  const res = await execute('tc', { gate: 'preflight' }, undefined, undefined, {});
  assert.equal(res.details.pass, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].detail.code, 0);
});

test('adlc_gate: a non-zero exit without JSON stays a gate FAILURE result, not a tool error', async (t) => {
  const { execute } = gateExecute(makeRepo(t), { stdout: '', stderr: 'boom', code: 2, killed: false });
  const res = await execute('tc', { gate: 'preflight' }, undefined, undefined, {});
  assert.equal(res.isError, false);
  assert.equal(res.details.pass, false);
});

test('verdictFailureReason classifies killed, codeless, JSON-less passes and real verdicts', () => {
  assert.match(verdictFailureReason({ code: 0, killed: true, stdout: '{}' }) ?? '', /killed/);
  assert.match(verdictFailureReason({ code: null, stdout: '{}' }) ?? '', /exit code/);
  assert.match(verdictFailureReason({ code: 0, stdout: '' }) ?? '', /no JSON verdict/);
  assert.match(verdictFailureReason({ code: 0, stdout: '   \n' }) ?? '', /no JSON verdict/);
  assert.match(verdictFailureReason({ code: 0, stdout: 'accepted\n' }) ?? '', /no JSON verdict/);
  assert.equal(verdictFailureReason({ code: 0, stdout: '{}' }), null);
  assert.equal(verdictFailureReason({ code: 0, stdout: '[]' }), null);
  assert.equal(verdictFailureReason({ code: 2, stdout: '' }), null);
  assert.equal(verdictFailureReason({ code: 1, stdout: 'text' }), null);
});

// ── /adlc-accept, driven through the real command handler ────────────────

function fakePi(acceptResult) {
  const handlers = {};
  const commands = {};
  const entries = [];
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    registerMessageRenderer() {},
    sendMessage() {},
    async exec(_cmd, args) { return args[0] === 'accept' ? acceptResult : { stdout: '', stderr: '', code: 0 }; },
    appendEntry(customType, data) { entries.push({ customType, data }); },
    handlers, commands, entries,
  };
}

function fakeCtx(cwd) {
  const notices = [];
  return {
    cwd,
    hasUI: true,
    ui: {
      setStatus() {}, setWidget() {},
      notify(msg, level) { notices.push({ msg, level }); },
      async select(_t, options) { return options[0]; },
      async confirm() { return true; },
    },
    notices,
  };
}

async function runAccept(t, acceptResult) {
  const root = makeRepo(t);
  const pi = fakePi(acceptResult);
  createExtension({ env: {} })(pi);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, fakeCtx(root));
  const ctx = fakeCtx(root);
  await pi.commands['adlc-accept'].handler('.adlc/packet.json', ctx);
  return ctx.notices;
}

test('/adlc-accept: a signal-killed accept exec records nothing', async (t) => {
  const notices = await runAccept(t, SIGNAL_KILLED);
  const failure = notices.find((n) => /acceptance gate FAILED/i.test(n.msg));
  assert.ok(failure, `expected a refusal, got ${JSON.stringify(notices)}`);
  assert.match(failure.msg, /no JSON verdict/);
  assert.ok(!notices.some((n) => /recorded P6 acceptance/i.test(n.msg)));
});

test('/adlc-accept: exit 0 with non-JSON stdout is refused, since accept --json always prints JSON', async (t) => {
  const notices = await runAccept(t, { stdout: 'accepted\n', stderr: '', code: 0 });
  assert.ok(notices.some((n) => /acceptance gate FAILED/i.test(n.msg)));
  assert.ok(!notices.some((n) => /recorded P6 acceptance/i.test(n.msg)));
});

test('/adlc-accept: a JSON {ok:true} from the CLI is still recorded', async (t) => {
  const notices = await runAccept(t, { stdout: JSON.stringify({ ok: true, revision: 'abcdef0123456' }), stderr: '', code: 0 });
  assert.ok(notices.some((n) => /recorded P6 acceptance/i.test(n.msg)), JSON.stringify(notices));
});
