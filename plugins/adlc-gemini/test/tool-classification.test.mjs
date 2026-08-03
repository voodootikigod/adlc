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
import { classifyTool, isShellTool } from '../rails-checker.mjs';

// Every agy MUTATING file tool must classify 'mutating' (so a rail write is
// denied). All five are structured file-content mutators.
for (const t of ['write_to_file', 'create_file', 'edit', 'replace_file_content', 'multi_replace_file_content']) {
  test(`agy mutating tool "${t}" classifies mutating`, () => {
    assert.equal(classifyTool(t), 'mutating');
  });
}

// Every agy READ / file-search tool must classify 'readonly' (never blocked,
// bypasses the rail check entirely). find_by_name is agy's file-search tool
// (Pattern/SearchDirectory/Extensions args, no file-content access) — read.
for (const t of ['view_file', 'list_dir', 'grep_search', 'codebase_search', 'read_file', 'find_by_name']) {
  test(`agy read tool "${t}" classifies readonly`, () => {
    assert.equal(classifyTool(t), 'readonly');
  });
}

// The shell tool is recognized (allowed in-session; CI-gated).
test('run_command is a shell tool', () => {
  assert.equal(isShellTool('run_command'), true);
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
