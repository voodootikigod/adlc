import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_PROTOCOLS,
  resolveHarnessProtocol,
  normalizeHookInput,
  formatHookOutput,
} from '../lib/protocol-adapters.mjs';
import { evaluatePreTool } from '../lib/pretool.mjs';

test('HARNESS_PROTOCOLS lists all 7 shipped harnesses and resolveHarnessProtocol maps aliases', () => {
  assert.deepEqual(
    [...HARNESS_PROTOCOLS],
    ['claude-code', 'codex', 'copilot', 'cursor', 'gemini', 'opencode', 'pi'],
  );
  assert.equal(resolveHarnessProtocol('agy'), 'gemini');
  assert.equal(resolveHarnessProtocol('jetski'), 'gemini');
  assert.equal(resolveHarnessProtocol('antigravity'), 'gemini');
  assert.equal(resolveHarnessProtocol('claude'), 'claude-code');
  assert.throws(() => resolveHarnessProtocol('unknown-harness'), /Unsupported harness protocol/);
});

test('normalizeHookInput normalizes event names, tool names, inputs, and cwds across harnesses', () => {
  const cc = normalizeHookInput('claude-code', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'a.mjs' },
    cwd: '/repo',
    session_id: 's1',
  });
  assert.equal(cc.event, 'pretool');
  assert.equal(cc.toolName, 'Edit');
  assert.deepEqual(cc.toolInput, { file_path: 'a.mjs' });
  assert.equal(cc.cwd, '/repo');
  assert.equal(cc.sessionId, 's1');

  const agy = normalizeHookInput('agy', {
    hookEventName: 'BeforeTool',
    toolName: 'run_command',
    toolInput: { CommandLine: 'git status' },
    workspace_roots: ['/ws'],
  });
  assert.equal(agy.harness, 'gemini');
  assert.equal(agy.event, 'pretool');
  assert.equal(agy.outerRoot, '/ws');

  assert.equal(normalizeHookInput('opencode', { event: 'tool.execute.after' }).event, 'posttool');
  assert.equal(normalizeHookInput('pi', { type: 'agent_end' }).event, 'stop');
  assert.equal(normalizeHookInput('cursor', { event: 'sessionStart' }).event, 'session-start');
});

test('formatHookOutput produces native deny, block, and context payloads for all 7 harnesses', () => {
  const deny = { decision: 'deny', reason: 'frozen rail hit' };
  const block = { decision: 'block', reason: 'missing manifest' };
  const ctx = { additionalContext: 'ADLC active ticket: T-1' };

  const cc = formatHookOutput('claude-code', 'pretool', deny);
  assert.equal(cc.exitCode, 0);
  assert.equal(cc.payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(formatHookOutput('claude-code', 'stop', block).payload.decision, 'block');
  assert.equal(formatHookOutput('claude-code', 'session-start', ctx).payload.hookSpecificOutput.additionalContext, ctx.additionalContext);

  const codex = formatHookOutput('codex', 'pretool', deny);
  assert.equal(codex.exitCode, 2);
  assert.equal(codex.payload.decision, 'block');
  assert.equal(formatHookOutput('codex', 'session-start', ctx).payload.hookSpecificOutput.additionalContext, ctx.additionalContext);
  assert.equal(formatHookOutput('codex', 'posttool', { advisory: 'warn' }).payload.systemMessage, 'warn');

  const copilot = formatHookOutput('copilot', 'pretool', deny);
  assert.equal(copilot.exitCode, 0);
  assert.deepEqual(copilot.payload, { reason: 'frozen rail hit' });

  // End-to-end Copilot payload with JSON-stringified toolArgs reaches denial.
  const copilotNorm = normalizeHookInput('copilot', {
    toolName: 'edit_file',
    toolArgs: JSON.stringify({ file_path: 'test/auth.test.mjs' }),
    cwd: '/repo',
  });
  assert.deepEqual(copilotNorm.toolInput, { file_path: 'test/auth.test.mjs' });
  const copilotEval = evaluatePreTool({ ...copilotNorm, rails: ['test/auth.test.mjs'] });
  assert.equal(copilotEval.decision, 'deny');
  const copilotWire = formatHookOutput('copilot', 'pretool', copilotEval);
  assert.equal(copilotWire.exitCode, 0);
  assert.match(copilotWire.payload.reason, /test\/auth\.test\.mjs/);

  // Unparseable or oversized (>256 KiB) Copilot toolArgs fails closed.
  const badCopilot = normalizeHookInput('copilot', { toolName: 'edit_file', toolArgs: '{bad-json' });
  assert.equal(badCopilot.toolInput.__unparseable, true);
  assert.equal(evaluatePreTool({ ...badCopilot, rails: ['test/auth.test.mjs'] }).decision, 'deny');
  const hugeToolArgs = JSON.stringify({ file_path: 'a.mjs', pad: 'x'.repeat(256 * 1024 + 10) });
  assert.equal(normalizeHookInput('copilot', { toolName: 'edit_file', toolArgs: hugeToolArgs }).toolInput.__unparseable, true);

  const cursor = formatHookOutput('cursor', 'pretool', deny);
  assert.equal(cursor.exitCode, 0);
  assert.equal(cursor.payload.permission, 'deny');
  assert.equal(cursor.payload.user_message, deny.reason);
  assert.equal(cursor.payload.agent_message, deny.reason);
  assert.equal(formatHookOutput('cursor', 'stop', block).payload.followup_message, block.reason);
  assert.equal(formatHookOutput('cursor', 'session-start', ctx).payload.additional_context, ctx.additionalContext);

  const gemini = formatHookOutput('gemini', 'pretool', deny);
  assert.equal(gemini.exitCode, 0);
  assert.equal(gemini.payload.decision, 'deny');
  assert.equal(gemini.payload.allow_tool, false);
  assert.equal(gemini.payload.deny_reason, deny.reason);
  const geminiStop = formatHookOutput('gemini', 'stop', block);
  assert.equal(geminiStop.exitCode, 0);
  assert.deepEqual(geminiStop.payload, { decision: 'continue', reason: block.reason });
  assert.equal(formatHookOutput('gemini', 'session-start', ctx).payload.hookSpecificOutput.additionalContext, ctx.additionalContext);

  const opencode = formatHookOutput('opencode', 'pretool', deny);
  assert.equal(opencode.payload.blocked, true);

  const pi = formatHookOutput('pi', 'pretool', deny);
  assert.equal(pi.payload.block, true);

  // Allow with no context produces native allow for gemini and empty stdout for other harnesses.
  for (const h of HARNESS_PROTOCOLS) {
    const res = formatHookOutput(h, 'pretool', { decision: 'allow' });
    assert.equal(res.exitCode, 0);
    if (h === 'gemini') {
      assert.deepEqual(res.payload, { decision: 'allow', allow_tool: true });
      assert.deepEqual(formatHookOutput('gemini', 'stop', { decision: 'allow' }).payload, { decision: 'stop' });
    } else {
      assert.equal(res.stdout, '');
    }
  }
});
