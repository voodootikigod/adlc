import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESS_PROTOCOLS,
  DECISION_LATTICE,
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
  assert.ok(DECISION_LATTICE.deny > DECISION_LATTICE.force_ask);
  assert.ok(DECISION_LATTICE.force_ask > DECISION_LATTICE.ask);
  assert.ok(DECISION_LATTICE.ask > DECISION_LATTICE.pass);
});

test('normalizeHookInput extracts nested toolCall/tool_call, preinvocation, workspacePaths, and conversationId', () => {
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

  const agyNested = normalizeHookInput('agy', {
    toolCall: { name: 'write_to_file', args: { TargetFile: 'src/a.js' } },
    workspacePaths: ['/ws/main', '/ws/extra'],
    conversationId: 'conv-42',
  });
  assert.equal(agyNested.harness, 'gemini');
  assert.equal(agyNested.event, 'pretool');
  assert.equal(agyNested.toolName, 'write_to_file');
  assert.equal(agyNested.toolInput.TargetFile, 'src/a.js');
  assert.deepEqual(agyNested.workspacePaths, ['/ws/main', '/ws/extra']);
  assert.equal(agyNested.outerRoot, '/ws/main');
  assert.equal(agyNested.conversationId, 'conv-42');
  assert.equal(agyNested.sessionId, 'conv-42');

  const snakeNested = normalizeHookInput('jetski', {
    event: 'PreInvocation',
    tool_call: { toolName: 'replace_file_content', parameters: { TargetFile: 'src/b.js' } },
    workspaceRoots: ['/ws/jetski'],
    conversation_id: 'js-99',
  });
  assert.equal(snakeNested.event, 'session-start');
  assert.equal(snakeNested.toolName, 'replace_file_content');
  assert.equal(snakeNested.toolInput.TargetFile, 'src/b.js');
  assert.equal(snakeNested.outerRoot, '/ws/jetski');
  assert.equal(snakeNested.conversationId, 'js-99');

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

test('formatHookOutput produces native payloads and 4-level Gemini lattice across all 7 harnesses', () => {
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

  // Gemini 4-level decision lattice: deny > force_ask > ask > pass
  const geminiDeny = formatHookOutput('gemini', 'pretool', deny);
  assert.equal(geminiDeny.exitCode, 0);
  assert.deepEqual(geminiDeny.payload, { decision: 'deny', reason: deny.reason, allow_tool: false, deny_reason: deny.reason });

  const geminiForceAsk = formatHookOutput('gemini', 'pretool', { decision: 'force_ask', reason: 'ambiguous shell' });
  assert.equal(geminiForceAsk.exitCode, 0);
  assert.deepEqual(geminiForceAsk.payload, { decision: 'force_ask', reason: 'ambiguous shell', allow_tool: false });

  const geminiAsk = formatHookOutput('gemini', 'pretool', { decision: 'ask', reason: 'confirm action' });
  assert.equal(geminiAsk.exitCode, 0);
  assert.deepEqual(geminiAsk.payload, { decision: 'ask', reason: 'confirm action' });

  const geminiPass = formatHookOutput('gemini', 'pretool', { decision: 'pass' });
  assert.equal(geminiPass.exitCode, 0);
  assert.deepEqual(geminiPass.payload, { decision: 'pass', allow_tool: true });

  const geminiStop = formatHookOutput('gemini', 'stop', block);
  assert.equal(geminiStop.exitCode, 0);
  assert.deepEqual(geminiStop.payload, { decision: 'continue', reason: block.reason });
  assert.deepEqual(formatHookOutput('gemini', 'stop', { decision: 'continue', reason: 'unverified' }).payload, { decision: 'continue', reason: 'unverified' });
  assert.equal(formatHookOutput('gemini', 'session-start', ctx).payload.hookSpecificOutput.additionalContext, ctx.additionalContext);
  assert.deepEqual(formatHookOutput('gemini', 'posttool', {}).payload, {});

  assert.equal(formatHookOutput('opencode', 'pretool', deny).payload.blocked, true);
  assert.equal(formatHookOutput('pi', 'pretool', deny).payload.block, true);

  for (const h of HARNESS_PROTOCOLS) {
    const res = formatHookOutput(h, 'pretool', { decision: 'allow' });
    assert.equal(res.exitCode, 0);
    if (h === 'gemini') {
      assert.deepEqual(res.payload, { decision: 'pass', allow_tool: true });
      assert.deepEqual(formatHookOutput('gemini', 'stop', { decision: 'allow' }).payload, { decision: 'stop' });
    } else {
      assert.equal(res.stdout, '');
    }
  }
});
