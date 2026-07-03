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
// Deliberately NO filesystem I/O here — staging a bounded window (so this
// stays cheap on an arbitrarily long transcript) is the caller's job, exactly
// as it already is in plugins/adlc-claude-code/hooks/adlc-hook.mjs's flail()
// mode (tailBytes/fileSize). Keeping I/O out of this module makes it trivially
// unit-testable and reusable by any Path-A harness with its own I/O primitives.

/** Tool-call count past which a session is considered context-degraded. */
export const DEFAULT_DEPTH_THRESHOLD = 40;

/** Transcript byte count past which a session is considered context-degraded
 * (mirrors the 256 KiB MAX_SCAN_BYTES window flail-detector's CC hook already
 * scans, per issue #48's "reuse flail-detector's existing ... approach"). */
export const DEFAULT_BYTES_THRESHOLD = 256 * 1024;

/**
 * Count tool-invocation occurrences in transcript text. Two shapes are
 * recognized (same two the flail-detector precedent — parse-log.mjs's
 * extractFileTargets / signals.mjs's tool-log line patterns — already know
 * about): a JSONL `"type":"tool_use"` block (the real Claude Code transcript
 * shape), and legacy prose "Writing <path>" / "Editing <path>" / "Created
 * <path>" tool-log lines. A plain occurrence count, not deduped — a tool
 * called 5 times counts 5, which is exactly the "session is deep" signal we
 * want (mirrors detectEditChurn's un-deduped per-path counting).
 *
 * @param {string} text
 * @returns {number}
 */
export function countToolCalls(text) {
  if (!text) return 0;
  const toolUseBlocks = text.match(/"type"\s*:\s*"tool_use"/g) ?? [];
  const proseToolLines = text.match(/^(?:Writing|Editing|Created)\s+\S+/gim) ?? [];
  return toolUseBlocks.length + proseToolLines.length;
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
 * Is the session context-degraded? True when EITHER signal is strictly past
 * its threshold (mirrors flail-detector's detectSizeExceeded: `bytes >
 * maxBytes`, not `>=` — exactly at the threshold is not yet degraded).
 *
 * @param {object} opts
 * @param {number} opts.depth
 * @param {number} opts.sessionBytes
 * @param {number} [opts.depthThreshold]
 * @param {number} [opts.bytesThreshold]
 * @returns {boolean}
 */
export function isDegraded({
  depth,
  sessionBytes,
  depthThreshold = DEFAULT_DEPTH_THRESHOLD,
  bytesThreshold = DEFAULT_BYTES_THRESHOLD,
}) {
  const depthDegraded = typeof depth === 'number' && depth > depthThreshold;
  const bytesDegraded = typeof sessionBytes === 'number' && sessionBytes > bytesThreshold;
  return depthDegraded || bytesDegraded;
}
