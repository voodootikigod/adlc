// test/depth-signal.test.mjs — the context-fitness proxy (issue #48, item 2).
//
// Mirrors flail-detector's transcript-size / tool-call-count scanning approach
// (packages/flail-detector/lib/signals.mjs detectSizeExceeded, and the JSONL
// tool_use counting done by parse-log.mjs's extractFileTargets) as the basis
// for a --depth/--session-bytes input. Pure functions — no filesystem I/O here
// (that lives in the CLI / hook, which stage a bounded window and pass the raw
// text in).
//
// Hard-band edges are inclusive (`>=`) via `@adlc/context-handoff` isHardDegraded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARD_BYTES, HARD_DEPTH, isHardDegraded } from '@adlc/context-handoff';
import {
  countToolCalls,
  computeDepthSignal,
  isDegraded,
  DEFAULT_DEPTH_THRESHOLD,
  DEFAULT_BYTES_THRESHOLD,
} from '../lib/depth-signal.mjs';
import {
  buildCodexRollout,
  functionCall,
  functionCallOutput,
  customToolCall,
  customToolCallOutput,
  patchApplyEnd,
  execCommandEnd,
  mcpToolCallEnd,
  webSearchCall,
  webSearchEnd,
  toolSearchCall,
  toolSearchOutput,
  imageGenerationCall,
  imageGenerationEnd,
  assistantMessage,
  designDocShapeLine,
} from './fixtures/codex-rollout.mjs';

test('countToolCalls: plain prose has zero tool calls', () => {
  assert.equal(countToolCalls('just some words\nmore words\n'), 0);
});

test('countToolCalls: counts JSONL tool_use blocks', () => {
  const text = [
    JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.mjs' } }] }),
    JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] }),
    JSON.stringify({ type: 'user', content: 'hi' }),
  ].join('\n');
  assert.equal(countToolCalls(text), 2);
});

test('countToolCalls: is a plain occurrence count, not deduped', () => {
  const text = Array.from({ length: 5 }, () => '"type":"tool_use"').join('\n');
  assert.equal(countToolCalls(text), 5);
});

// --- Codex rollout shape (T-01M05BWTEYKHEK3JJX71NXXJ4H) --------------------
//
// The counter recognized only Anthropic `tool_use` blocks, so EVERY Codex
// session read as depth 0 and both the handoff deny and the build gate's
// depth check were inert on Codex. Structure below adjudicated against 8 real
// on-disk rollouts (codex-cli 0.118.0 - 0.142.5); see
// ./fixtures/codex-rollout.mjs for what is and is not counted, and why.

test('countToolCalls: counts a Codex function_call response_item', () => {
  assert.equal(countToolCalls(functionCall(1)), 1);
});

test('countToolCalls: counts a Codex custom_tool_call response_item', () => {
  assert.equal(countToolCalls(customToolCall(1)), 1);
});

test('countToolCalls: a call/output PAIR counts once — the output half is not a second call', () => {
  // `function_call_output` contains `function_call` as a prefix; only the
  // closing quote in the pattern keeps it from matching. If that quote is ever
  // dropped, every Codex call doubles and shallow sessions lock out.
  assert.equal(countToolCalls(`${functionCall(1)}\n${functionCallOutput(1)}`), 1);
  assert.equal(countToolCalls(`${customToolCall(1)}\n${customToolCallOutput(1)}`), 1);
  assert.equal(countToolCalls(functionCallOutput(1)), 0, 'an output on its own is not a call');
  assert.equal(countToolCalls(customToolCallOutput(1)), 0, 'an output on its own is not a call');
});

test('countToolCalls: event_msg mirrors of a call are not counted a second time', () => {
  // patch_apply_end / exec_command_end / mcp_tool_call_end / web_search_end /
  // image_generation_end are event_msg echoes of a call a response_item already
  // recorded. On the real rollouts patch_apply_end tracked custom_tool_call
  // 1:1; counting both doubles depth.
  assert.equal(countToolCalls(patchApplyEnd(1)), 0);
  assert.equal(countToolCalls(execCommandEnd(1)), 0);
  assert.equal(countToolCalls(mcpToolCallEnd(1)), 0);
  assert.equal(countToolCalls(webSearchEnd(1)), 0);
  assert.equal(countToolCalls(imageGenerationEnd(1)), 0);
  assert.equal(
    countToolCalls(`${customToolCall(1)}\n${patchApplyEnd(1)}\n${customToolCallOutput(1)}`),
    1,
    'one apply_patch is depth 1, not 2 or 3',
  );
});

test('countToolCalls: every enumerated response_item call type counts, and only once', () => {
  // A scan of all 407 rollouts on disk enumerated exactly five response_item
  // call tags. Missing any one of them is not merely imprecise: a session can
  // sit at 39 recognized calls plus one unrecognized call and slip under the
  // inclusive 40 threshold, which is a degraded session cleared to mutate.
  for (const [call, twin] of [
    [functionCall, functionCallOutput],
    [customToolCall, customToolCallOutput],
    [webSearchCall, webSearchEnd],
    [toolSearchCall, toolSearchOutput],
    [imageGenerationCall, imageGenerationEnd],
  ]) {
    assert.equal(countToolCalls(call(1)), 1, `${call.name} must count`);
    assert.equal(countToolCalls(twin(1)), 0, `${twin.name} must not count`);
    assert.equal(countToolCalls(`${call(1)}\n${twin(1)}`), 1, `${call.name} + twin is one call`);
  }
});

test('countToolCalls: 39 shell calls plus one rarer call reaches the hard band, not 39', () => {
  // The exact bypass a cross-model review found in the first cut of this fix,
  // which recognized only function_call and custom_tool_call: 39 counted calls
  // plus one web search read as 39, one short of the inclusive threshold, so a
  // high-risk mutation proceeded in a session that was actually at 40.
  for (const rarer of ['webSearchCalls', 'toolSearchCalls', 'imageGenerationCalls']) {
    const { text, expectedToolCalls } = buildCodexRollout({
      functionCalls: HARD_DEPTH - 1,
      [rarer]: 1,
    });
    assert.equal(expectedToolCalls, HARD_DEPTH);
    assert.equal(countToolCalls(text), HARD_DEPTH, `39 shell calls + one ${rarer} is ${HARD_DEPTH}`);
    assert.equal(
      isDegraded({ depth: countToolCalls(text), sessionBytes: 0 }),
      true,
      `a session at the hard band via one ${rarer} must be degraded`,
    );
  }
});

test('countToolCalls: a plain Codex assistant message is not a tool call', () => {
  assert.equal(countToolCalls(assistantMessage(1)), 0);
});

test('countToolCalls: an escaped rollout embedded in a tool output does not inflate the count', () => {
  // A Codex session that reads a rollout file (or this repo's source) carries
  // \"type\":\"function_call\" inside a JSON string. The backslash before the
  // quote means the pattern cannot match — which is why the regex count
  // equalled the JSON-parsed count exactly on all 8 real rollouts.
  const { text, expectedToolCalls } = buildCodexRollout({ functionCalls: 3, withNestedTranscript: true });
  assert.equal(countToolCalls(text), expectedToolCalls);
});

test('countToolCalls: a sanitized real-shape rollout returns the exact known count', () => {
  const { text, expectedToolCalls } = buildCodexRollout({
    functionCalls: 31,
    customToolCalls: 12,
    messages: 7,
  });
  assert.equal(expectedToolCalls, 43);
  assert.equal(countToolCalls(text), 43);
  // The exact bug: this same transcript counted 0 before the fix.
  assert.ok(countToolCalls(text) >= HARD_DEPTH, 'a 43-call session must reach the hard band');
});

test('countToolCalls: the codex-context-v1.md role/tool_calls shape is deliberately not counted', () => {
  // Adjudication found ZERO records carrying a `tool_calls` array across all 8
  // real rollouts — that documented shape was never captured from a real
  // session. Counting it would be guessing, so the counter stays silent.
  assert.equal(countToolCalls(designDocShapeLine(1)), 0);
});

test('countToolCalls: Codex and Anthropic shapes sum in one mixed transcript', () => {
  const text = [
    JSON.stringify({ type: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] }),
    functionCall(1),
    customToolCall(2),
    'Writing src/a.mjs',
  ].join('\n');
  assert.equal(countToolCalls(text), 4);
});

test('countToolCalls: whitespace around the JSON colon is tolerated in the Codex shape', () => {
  assert.equal(countToolCalls('"type" : "function_call"'), 1);
  assert.equal(countToolCalls('"type"  :  "custom_tool_call"'), 1);
});

test('computeDepthSignal: a Codex rollout crosses the hard depth band it used to sleep through', () => {
  const shallow = buildCodexRollout({ functionCalls: HARD_DEPTH - 1 });
  const deep = buildCodexRollout({ functionCalls: HARD_DEPTH });
  assert.equal(computeDepthSignal({ text: shallow.text }).depth, HARD_DEPTH - 1);
  assert.equal(computeDepthSignal({ text: deep.text }).depth, HARD_DEPTH);
  assert.equal(isDegraded({ depth: computeDepthSignal({ text: shallow.text }).depth, sessionBytes: 0 }), false);
  assert.equal(isDegraded({ depth: computeDepthSignal({ text: deep.text }).depth, sessionBytes: 0 }), true);
});

test('computeDepthSignal: reports bytes and toolCallCount from raw text', () => {
  const text = '"type":"tool_use"\n"type":"tool_use"\nhello';
  const result = computeDepthSignal({ text });
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.bytes, Buffer.byteLength(text, 'utf8'));
});

test('computeDepthSignal: an explicit bytes override wins over text-derived bytes', () => {
  const result = computeDepthSignal({ text: 'short', bytes: 999999 });
  assert.equal(result.bytes, 999999);
});

test('isDegraded: depth under threshold and bytes under threshold → not degraded', () => {
  assert.equal(isDegraded({ depth: 5, sessionBytes: 100, depthThreshold: 40, bytesThreshold: 1000 }), false);
});

test('isDegraded: depth exceeding threshold → degraded', () => {
  assert.equal(isDegraded({ depth: 41, sessionBytes: 0, depthThreshold: 40, bytesThreshold: 1_000_000 }), true);
});

test('isDegraded: bytes exceeding threshold → degraded (even with low depth)', () => {
  assert.equal(isDegraded({ depth: 1, sessionBytes: 300_000, depthThreshold: 40, bytesThreshold: 262_144 }), true);
});

test('isDegraded: exactly AT threshold is degraded (inclusive >=, context-handoff hard band)', () => {
  assert.equal(isDegraded({ depth: HARD_DEPTH, sessionBytes: 0 }), true);
  assert.equal(isDegraded({ depth: 0, sessionBytes: HARD_BYTES }), true);
  assert.equal(
    isDegraded({
      depth: HARD_DEPTH,
      sessionBytes: HARD_BYTES,
      depthThreshold: HARD_DEPTH,
      bytesThreshold: HARD_BYTES,
    }),
    true,
  );
});

test('isDegraded: custom thresholds also use inclusive >= at the edge', () => {
  assert.equal(isDegraded({ depth: 10, sessionBytes: 0, depthThreshold: 10, bytesThreshold: 1_000_000 }), true);
  assert.equal(isDegraded({ depth: 9, sessionBytes: 500, depthThreshold: 10, bytesThreshold: 500 }), true);
  assert.equal(isDegraded({ depth: 9, sessionBytes: 499, depthThreshold: 10, bytesThreshold: 500 }), false);
});

test('isDegraded: defaults alias HARD_* from context-handoff', () => {
  assert.equal(DEFAULT_DEPTH_THRESHOLD, HARD_DEPTH);
  assert.equal(DEFAULT_BYTES_THRESHOLD, HARD_BYTES);
});

test('isDegraded: default path matches isHardDegraded for depth and bytes', () => {
  assert.equal(isDegraded({ depth: HARD_DEPTH, sessionBytes: 0 }), isHardDegraded({ depth: HARD_DEPTH }));
  assert.equal(isDegraded({ depth: 0, sessionBytes: HARD_BYTES }), isHardDegraded({ bytes: HARD_BYTES }));
  assert.equal(isDegraded({ depth: HARD_DEPTH - 1, sessionBytes: HARD_BYTES - 1 }), isHardDegraded({
    depth: HARD_DEPTH - 1,
    bytes: HARD_BYTES - 1,
  }));
  assert.equal(isDegraded({ depth: 5, sessionBytes: 100 }), isHardDegraded({ depth: 5, bytes: 100 }));
});
