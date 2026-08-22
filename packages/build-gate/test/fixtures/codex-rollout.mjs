// codex-rollout.mjs — a SANITIZED Codex rollout fixture builder.
//
// Structure adjudicated (T-01M05BWTEYKHEK3JJX71NXXJ4H) against every rollout on
// disk — 407 files under ~/.codex/sessions spanning codex-cli 0.118.0 - 0.149.0.
// Only the STRUCTURE is reproduced here — key names, record nesting and type
// tags. Every value is synthetic; no captured session text is committed.
//
// The adjudicated shape: a rollout is JSONL, one record per line, each record
// `{ timestamp, type, payload }`. The model's tool CALLS are `type:
// "response_item"` records. That scan enumerated the COMPLETE set of
// response_item call tags, and all five are counted: `function_call` (shell,
// MCP, most tools), `custom_tool_call` (apply_patch and other custom tools),
// `web_search_call`, `tool_search_call`, `image_generation_call`.
//
// NOT counted, and this file exists partly to pin that:
//   - `function_call_output` / `custom_tool_call_output` / `tool_search_output`
//     — the RESULT half of a call/output pair. Counting them doubles the call.
//   - `patch_apply_end` / `exec_command_end` / `mcp_tool_call_end` /
//     `web_search_end` / `image_generation_end` — `event_msg` MIRRORS of a call
//     that a `response_item` already recorded. On the real rollouts
//     patch_apply_end tracked custom_tool_call 1:1 (e.g. 22/22, 14/14) or just
//     under it when an apply failed; counting both roughly doubles patch depth.
//
// Both directions are failure modes. Over-counting re-introduces the
// false-lockout class of bug that T-01M03J291182MXD1KEKM2PRKTS just fixed;
// under-counting lets a session sit one call under an inclusive threshold and
// mutate anyway (the cross-model review's catch on the first cut of this fix,
// which excluded the three rarer call types). Matching exactly the enumerated
// call tags — and nothing that echoes them — is what avoids both, so every call
// fixture below ships alongside its twin.

const ISO = '2026-01-01T00:00:00.000Z';

const line = (type, payload) => JSON.stringify({ timestamp: ISO, type, payload });

/** A `function_call` response_item — the shape shell/MCP tool calls take. */
export const functionCall = (n) =>
  line('response_item', {
    type: 'function_call',
    name: 'shell',
    arguments: JSON.stringify({ command: ['echo', `synthetic-${n}`] }),
    call_id: `call_${n}`,
  });

/** The RESULT half of a function_call. Must not add to the count. */
export const functionCallOutput = (n) =>
  line('response_item', { type: 'function_call_output', call_id: `call_${n}`, output: 'synthetic output' });

/** A `custom_tool_call` response_item — the shape apply_patch takes. */
export const customToolCall = (n) =>
  line('response_item', {
    type: 'custom_tool_call',
    status: 'completed',
    call_id: `call_${n}`,
    name: 'apply_patch',
    input: 'synthetic patch input',
  });

/** The RESULT half of a custom_tool_call. Must not add to the count. */
export const customToolCallOutput = (n) =>
  line('response_item', { type: 'custom_tool_call_output', call_id: `call_${n}`, output: 'synthetic output' });

/** The event_msg MIRROR of an apply_patch. Must not add to the count. */
export const patchApplyEnd = (n) =>
  line('event_msg', {
    type: 'patch_apply_end',
    call_id: `call_${n}`,
    turn_id: `turn_${n}`,
    stdout: '',
    stderr: '',
    success: true,
    changes: {},
    status: 'completed',
  });

/** The event_msg MIRROR of a shell call. Must not add to the count. */
export const execCommandEnd = (n) =>
  line('event_msg', { type: 'exec_command_end', call_id: `call_${n}`, exit_code: 0, status: 'completed' });

/** The event_msg MIRROR of an MCP call. Must not add to the count. */
export const mcpToolCallEnd = (n) =>
  line('event_msg', { type: 'mcp_tool_call_end', call_id: `call_${n}`, status: 'completed' });

/** A `web_search_call` response_item — a genuine call, counted. */
export const webSearchCall = (n) =>
  line('response_item', { type: 'web_search_call', id: `ws_${n}`, status: 'completed' });

/** The event_msg MIRROR of a web search. Must not add to the count. */
export const webSearchEnd = (n) =>
  line('event_msg', { type: 'web_search_end', call_id: `call_${n}`, status: 'completed' });

/** A `tool_search_call` response_item — a genuine call, counted. */
export const toolSearchCall = (n) =>
  line('response_item', { type: 'tool_search_call', id: `ts_${n}`, status: 'completed' });

/** The RESULT half of a tool search. Must not add to the count. */
export const toolSearchOutput = (n) =>
  line('response_item', { type: 'tool_search_output', id: `ts_${n}`, output: 'synthetic output' });

/** An `image_generation_call` response_item — a genuine call, counted. */
export const imageGenerationCall = (n) =>
  line('response_item', { type: 'image_generation_call', id: `ig_${n}`, status: 'completed' });

/** The event_msg MIRROR of an image generation. Must not add to the count. */
export const imageGenerationEnd = (n) =>
  line('event_msg', { type: 'image_generation_end', call_id: `call_${n}`, status: 'completed' });

/** A plain assistant message response_item — carries a role, but no tool call. */
export const assistantMessage = (n) =>
  line('response_item', {
    type: 'message',
    role: 'assistant',
    phase: 'final',
    content: [{ type: 'output_text', text: `synthetic reply ${n}` }],
  });

/**
 * A function_call_output whose `output` embeds a whole serialized rollout line.
 * This happens for real whenever a Codex session reads a rollout file (or this
 * repo's own source). JSON escaping turns the inner `"type":"function_call"`
 * into `\"type\":\"function_call\"`, which the counter's regex must NOT match —
 * verified against the real rollouts, where the regex count equalled the
 * JSON-parsed count exactly on all 8 files.
 */
export const nestedTranscriptOutput = (n) =>
  line('response_item', {
    type: 'function_call_output',
    call_id: `call_${n}`,
    output: `${functionCall(9000)}\n${customToolCall(9001)}`,
  });

/**
 * Build a sanitized Codex rollout with a KNOWN tool-call count.
 *
 * @param {object} opts
 * @param {number} [opts.functionCalls] - `function_call` records (each with its output twin)
 * @param {number} [opts.customToolCalls] - `custom_tool_call` records (each with its output twin AND its patch_apply_end mirror)
 * @param {number} [opts.webSearchCalls] - `web_search_call` records (each with its web_search_end mirror)
 * @param {number} [opts.toolSearchCalls] - `tool_search_call` records (each with its output twin)
 * @param {number} [opts.imageGenerationCalls] - `image_generation_call` records (each with its image_generation_end mirror)
 * @param {number} [opts.messages] - plain assistant messages (no tool call)
 * @param {boolean} [opts.withNestedTranscript] - append an output record embedding an escaped rollout line
 * @returns {{ text: string, expectedToolCalls: number }}
 */
export function buildCodexRollout({
  functionCalls = 0,
  customToolCalls = 0,
  webSearchCalls = 0,
  toolSearchCalls = 0,
  imageGenerationCalls = 0,
  messages = 0,
  withNestedTranscript = false,
} = {}) {
  const lines = [
    line('session_meta', { id: 'synthetic-session', cli_version: '0.142.5', cwd: '/synthetic', originator: 'codex_cli_rs' }),
  ];
  let n = 0;
  for (let i = 0; i < functionCalls; i += 1) {
    n += 1;
    lines.push(functionCall(n), execCommandEnd(n), functionCallOutput(n));
  }
  for (let i = 0; i < customToolCalls; i += 1) {
    n += 1;
    lines.push(customToolCall(n), patchApplyEnd(n), customToolCallOutput(n));
  }
  for (let i = 0; i < webSearchCalls; i += 1) {
    n += 1;
    lines.push(webSearchCall(n), webSearchEnd(n));
  }
  for (let i = 0; i < toolSearchCalls; i += 1) {
    n += 1;
    lines.push(toolSearchCall(n), toolSearchOutput(n));
  }
  for (let i = 0; i < imageGenerationCalls; i += 1) {
    n += 1;
    lines.push(imageGenerationCall(n), imageGenerationEnd(n));
  }
  for (let i = 0; i < messages; i += 1) {
    n += 1;
    lines.push(assistantMessage(n));
  }
  if (withNestedTranscript) {
    n += 1;
    lines.push(nestedTranscriptOutput(n));
  }
  return {
    text: `${lines.join('\n')}\n`,
    expectedToolCalls:
      functionCalls + customToolCalls + webSearchCalls + toolSearchCalls + imageGenerationCalls,
  };
}

/**
 * The `role: "assistant"` + `tool_calls: [...]` shape that
 * packages/context-handoff/serialization/codex-context-v1.md documents. The
 * adjudication found ZERO records of this shape across all 8 real rollouts
 * (0 records carrying a `tool_calls` array, at any nesting level) — the design
 * doc is aspirational, not a capture. Kept here so the counter's deliberate
 * silence on it is pinned rather than accidental.
 */
export const designDocShapeLine = (n) =>
  JSON.stringify({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: `call_${n}`, function: { name: 'shell', arguments: '{}' } }],
  });
