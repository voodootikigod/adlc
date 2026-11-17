// tool-classification.test.mjs — characterization/audit of the tool-name
// classifier against agy's REAL tool set (spec F4/G3, BLOCKING).
//
// The tool set below was captured live, not guessed:
//  - `strings -n 4 "$(command -v agy)"` confirmed create_file/edit exist as
//    literal strings in the agy binary (design-time probing);
//  - `grep -aoE '"tool_calls":\[\{"name":"[a-z_]+"' ~/.gemini/antigravity-cli/
//    brain/*/.system_generated/logs/transcript*.jsonl` over every local agy
//    session transcript enumerated every tool name agy has ACTUALLY invoked as
//    a top-level tool call (20 distinct names, several thousand calls).
//
// `adversarial_reviewer` was deliberately EXCLUDED: a naive `"name":"..."` grep
// (not anchored to `tool_calls`) also matches it, but it is only ever the
// `name` argument of a `define_subagent` call (a user-chosen subagent label),
// never a `tool_calls[].name` itself — it is not a real tool.
//
// `generate_image` is deliberately NOT asserted allow/deny either way here — see
// the dedicated test below explaining why 'other' (fail-closed) is correct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, hasMutatingPayloadDeep, isShellTool } from '../rails-checker.mjs';

// Every agy MUTATING file tool must classify 'mutating' (so a rail write is
// denied). All five are structured file-content mutators.
for (const t of ['write_to_file', 'create_file', 'edit', 'replace_file_content', 'multi_replace_file_content']) {
  test(`agy mutating tool "${t}" classifies mutating`, () => {
    assert.equal(classifyTool(t), 'mutating');
  });
}

// MUTATING_TOOL_HINTS is a general substring hint list, not limited to agy's live
// tool set — pin the 'modify' hint specifically (a hypothetical future tool name
// carrying it, e.g. a "modify_file"-style verb from another harness).
test('a tool name carrying only the "modify" hint classifies mutating', () => {
  assert.equal(classifyTool('modify_file'), 'mutating');
});

// Every agy READ / file-search tool must classify 'readonly' (never blocked,
// bypasses the rail check entirely). find_by_name is agy's file-search tool
// (Pattern/SearchDirectory/Extensions args, no file-content access) — read.
for (const t of ['view_file', 'list_dir', 'grep_search', 'codebase_search', 'read_file', 'find_by_name']) {
  test(`agy read tool "${t}" classifies readonly`, () => {
    assert.equal(classifyTool(t), 'readonly');
  });
}

// The shell tools across Antigravity (run_command) and Gemini CLI (run_shell_command) are recognized.
test('run_command and run_shell_command are shell tools', () => {
  assert.equal(isShellTool('run_command'), true);
  assert.equal(isShellTool('run_shell_command', { command: 'npm test', dir_path: '/repo' }), true);
});

test('PURE_READS keep readonly classification with file path args and MCP read tools', () => {
  assert.equal(classifyTool('read_file', { Path: '/repo/src/frozen.js' }), 'readonly');
  assert.equal(classifyTool('read_file', { filePath: '/repo/src/frozen.js' }), 'readonly');
  assert.equal(classifyTool('read_file', { path: 'src/frozen.js' }), 'readonly');
  assert.equal(classifyTool('read_file', { Path: 'src/frozen.js', CodeContent: 'tamper' }), 'other');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'explore' }), 'readonly');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'codegraph_explore' }), 'readonly');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'fs', ToolName: 'write_file', Arguments: { path: 'frozen.js' } }), 'mutating');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'custom', ToolName: 'unknown_action', Arguments: { path: 'frozen.js' } }), 'other');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'codegraph_explore', Arguments: { TargetFile: 'frozen.js' } }), 'other');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'codegraph_explore', Arguments: { command: 'rm frozen.js' } }), 'other');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'codegraph_explore', parameters: { command: 'rm frozen.js' } }), 'other');
  assert.equal(classifyTool('call_mcp_tool', { ServerName: 'codegraph', ToolName: 'codegraph_explore', command: 'rm frozen.js' }), 'other');
  assert.equal(classifyTool('list_resources', { ServerName: 'mcp' }), 'readonly');
  assert.equal(classifyTool('read_resource', { ServerName: 'mcp', Uri: 'doc://1' }), 'readonly');
  assert.equal(hasMutatingPayloadDeep({ a: { b: { c: { d: { e: { query: 'ok' } } } } } }), false);
  assert.equal(hasMutatingPayloadDeep({ a: { b: { c: { d: { e: { f: { query: 'too-deep' } } } } } } }), true);
  assert.equal(
    classifyTool('call_mcp_tool', {
      ServerName: 'codegraph',
      ToolName: 'codegraph_explore',
      Arguments: { a: { b: { c: { d: { query: 'ok' } } } } },
    }),
    'readonly'
  );
  assert.equal(
    classifyTool('call_mcp_tool', {
      ServerName: 'codegraph',
      ToolName: 'codegraph_explore',
      Arguments: { a: { b: { c: { d: { e: { query: 'too-deep' } } } } } },
    }),
    'other'
  );
});

// Every agy NON-FILE tool (no file-path argument in any observed transcript
// call: manage_task, schedule, search_web, list_permissions, send_message,
// ask_question, invoke_subagent, ask_permission, manage_subagents,
// define_subagent, read_url_content) must classify 'readonly' so it is
// unconditionally allowed. Left as 'other' they would be treated as an opaque
// mutator with no verifiable target and denied while enforcement is active
// (see adlc-cursor's hooks/adlc-rails-guard.mjs `decide()` opaque-tool branch,
// which the agy hook adapter is expected to mirror) — breaking core agy
// workflows like asking the user a question or listing background tasks.
for (const t of [
  'manage_task', 'schedule', 'search_web', 'list_permissions', 'send_message',
  'ask_question', 'invoke_subagent', 'ask_permission', 'manage_subagents',
  'define_subagent', 'read_url_content',
]) {
  test(`agy non-file tool "${t}" classifies readonly (must be allowed)`, () => {
    assert.equal(classifyTool(t), 'readonly');
  });
}

// generate_image is INTENTIONALLY left classified 'other', not 'readonly'.
// Its observed args (AspectRatio/ImageName/Prompt) carry no PATH_KEYS-matching
// argument, but it writes a new image file to the workspace — it IS a mutator,
// just one the name-based classifier cannot prove a path for. 'other' with no
// inspectable path fails CLOSED under active enforcement (denied), which is the
// SAFE outcome for an ambiguous mutator — do NOT "fix" this to 'readonly' to
// silence a future audit; that would open a real rails bypass.
test('generate_image classifies other (ambiguous mutator, fails closed by design)', () => {
  assert.equal(classifyTool('generate_image'), 'other');
});
