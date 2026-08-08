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
