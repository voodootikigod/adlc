// depth-signal.mjs — the context-fitness proxy (issue #48, item 2).
//
// A machine-checkable proxy for "this session is deep" (context rot). Mirrors
// packages/flail-detector's existing scanning approach: a byte-capped window
// of the transcript, and a simple occurrence count over it (see
// flail-detector/lib/signals.mjs detectSizeExceeded / detectEditChurn — same
// shape: count occurrences of a pattern, compare to a threshold). This module
// is the shared basis for the --depth/--session-bytes CLI inputs described in
// the issue: a caller (the CC hook, a CI wrapper, any Path-A harness) reads a
// bounded window of its own transcript and calls computeDepthSignal() on the
// raw text, then isDegraded() against a threshold.
//
// Absolute hard-band denial consumes `@adlc/context-handoff` `isHardDegraded`
// (inclusive `>=` against HARD_*). Local DEFAULT_* aliases are re-exports of
// HARD_DEPTH / HARD_BYTES so plugins cannot drift from thresholds.mjs.
//
// Deliberately NO filesystem I/O here — staging a bounded window (so this
// stays cheap on an arbitrarily long transcript) is the caller's job, exactly
// as it already is in plugins/adlc-claude-code/hooks/adlc-hook.mjs's flail()
// mode (tailBytes/fileSize). Keeping I/O out of this module makes it trivially
// unit-testable and reusable by any Path-A harness with its own I/O primitives.

import { HARD_BYTES, HARD_DEPTH, isHardDegraded } from '@adlc/context-handoff';

/** Tool-call count at which a session is considered context-degraded (HARD_DEPTH). */
export const DEFAULT_DEPTH_THRESHOLD = HARD_DEPTH;

/** Transcript byte count at which a session is considered context-degraded
 * (HARD_BYTES — 256 KiB). */
export const DEFAULT_BYTES_THRESHOLD = HARD_BYTES;

/**
 * Count tool-invocation occurrences in transcript text. Three shapes are
 * recognized: a JSONL `"type":"tool_use"` block (the Claude Code transcript
 * shape); a Codex rollout `response_item` carrying one of the five call tags
 * enumerated below (the Codex shape); and
 * legacy prose "Writing <path>" / "Editing <path>" / "Created <path>" tool-log
 * lines (the flail-detector precedent — parse-log.mjs's extractFileTargets /
 * signals.mjs's tool-log line patterns already know these). A plain occurrence
 * count, not deduped — a tool called 5 times counts 5, which is exactly the
 * "session is deep" signal we want (mirrors detectEditChurn's un-deduped
 * per-path counting).
 *
 * The Codex alternation was adjudicated against every rollout on disk
 * (407 files under ~/.codex/sessions, codex-cli 0.118.0 - 0.149.0): each is
 * JSONL of `{timestamp,type,payload}` records, and the model's tool CALLS are
 * `response_item` records. That scan enumerated the COMPLETE set of
 * `response_item` call tags — `function_call` (shell/MCP/most tools),
 * `custom_tool_call` (apply_patch), `web_search_call`, `tool_search_call`,
 * `image_generation_call` — and all five are matched. An allowlist rather than
 * a `\w+_call` wildcard: an unrecognized future tag should under-count
 * visibly, not match something that turns out to be a mirror. Before this,
 * Codex sessions with over a thousand real tool calls all counted 0.
 *
 * What is deliberately NOT matched:
 *   - The closing quote in the pattern is load-bearing. It is what stops the
 *     RESULT half of each pair — `function_call_output`,
 *     `custom_tool_call_output` — from doubling every call.
 *   - `patch_apply_end` / `exec_command_end` / `mcp_tool_call_end` /
 *     `web_search_end` / `image_generation_end` are `event_msg` MIRRORS of a
 *     call a `response_item` already recorded. On the real rollouts
 *     `patch_apply_end` tracked `custom_tool_call` 1:1.
 * Over-counting either way would re-introduce the false-lockout bug class that
 * the context-rot threshold recalibration just fixed; under-counting lets a
 * degraded session slip under an inclusive threshold. Matching exactly the
 * enumerated call tags, and nothing that echoes them, is what avoids both.
 *
 * @param {string} text
 * @returns {number}
 */
export function countToolCalls(text) {
  if (!text) return 0;
  const toolCallRecords =
    text.match(/"type"\s*:\s*"(?:tool_use|function_call|custom_tool_call|web_search_call|tool_search_call|image_generation_call)"/g) ?? [];
  const proseToolLines = text.match(/^(?:Writing|Editing|Created)\s+\S+/gim) ?? [];
  return toolCallRecords.length + proseToolLines.length;
}

/**
 * Compute the raw depth signal from a chunk of transcript text.
 *
 * @param {object} opts
 * @param {string} opts.text - raw transcript text (a bounded window; caller's job to cap it)
 * @param {number} [opts.bytes] - explicit byte count override (e.g. the ORIGINAL
 *   file's full size, when `text` is only a tail window of it — the byte
 *   signal should reflect the whole session, not just the scanned window)
 * @returns {{ bytes: number, toolCallCount: number, depth: number }}
 *   `depth` is the tool-call-count proxy (the --depth CLI input); `bytes` is
 *   the --session-bytes CLI input.
 */
export function computeDepthSignal({ text, bytes } = {}) {
  const toolCallCount = countToolCalls(text ?? '');
  const resolvedBytes = typeof bytes === 'number' ? bytes : Buffer.byteLength(text ?? '', 'utf8');
  return { bytes: resolvedBytes, toolCallCount, depth: toolCallCount };
}

/**
 * Is the session context-degraded? True when any available hard-band signal is
 * at or past its threshold (inclusive `>=`, matching context-handoff
 * `evaluateBands` / `isHardDegraded`).
 *
 * Default thresholds use `isHardDegraded` directly. Custom CLI/env thresholds
 * keep the same inclusive edge rule locally (no strict `>`).
 *
 * @param {object} opts
 * @param {number} [opts.depth]
 * @param {number} [opts.sessionBytes]
 * @param {number} [opts.bytes] - alias for sessionBytes (computeDepthSignal field)
 * @param {number} [opts.pct] - optional percent signal (defaults path only)
 * @param {number} [opts.depthThreshold]
 * @param {number} [opts.bytesThreshold]
 * @returns {boolean}
 */
export function isDegraded({
  depth,
  sessionBytes,
  bytes,
  pct,
  depthThreshold = DEFAULT_DEPTH_THRESHOLD,
  bytesThreshold = DEFAULT_BYTES_THRESHOLD,
} = {}) {
  // Prefer explicit sessionBytes; accept computeDepthSignal()'s `bytes` field too.
  const resolvedBytes = typeof sessionBytes === 'number' ? sessionBytes : bytes;
  const usingDefaults =
    depthThreshold === DEFAULT_DEPTH_THRESHOLD && bytesThreshold === DEFAULT_BYTES_THRESHOLD;
  if (usingDefaults) {
    return isHardDegraded({ depth, bytes: resolvedBytes, pct });
  }
  const depthDegraded = typeof depth === 'number' && depth >= depthThreshold;
  const bytesDegraded = typeof resolvedBytes === 'number' && resolvedBytes >= bytesThreshold;
  return depthDegraded || bytesDegraded;
}
