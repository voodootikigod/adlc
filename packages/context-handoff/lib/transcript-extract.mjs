/**
 * Model narrative extraction from a Claude Code transcript (JSONL).
 *
 * The host reads the transcript; the agent never hands one over. Parsing is
 * fail-soft per line — a transcript is an append-only log a live process may be
 * writing, so a half-flushed final line is normal and must not lose the
 * narrative in the lines before it.
 *
 * "Final assistant message" is the trailing run of `type: "assistant"` entries
 * that share the last entry's `requestId`: Claude Code splits one model turn
 * across several entries (text, tool_use, more text), and only the request id
 * groups them back into the message a human would call the last thing it said.
 */

import { truncateUtf8 } from './text-cap.mjs';

/** Extracted narrative is capped — it is one message, not a session log. */
export const MAX_NARRATIVE_BYTES = 32 * 1024;

export const NARRATIVE_TRUNCATION_MARKER =
  '\n\n_[adlc: model narrative truncated]_\n';

/**
 * Parse JSONL, skipping anything that is not a JSON object.
 * @param {string} jsonlText
 * @returns {{ entries: object[], skipped: number }}
 */
export function parseTranscript(jsonlText) {
  if (typeof jsonlText !== 'string' || jsonlText.length === 0) {
    return { entries: [], skipped: 0 };
  }
  const entries = [];
  let skipped = 0;
  for (const line of jsonlText.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        skipped += 1;
        continue;
      }
      entries.push(value);
    } catch {
      skipped += 1;
    }
  }
  return { entries, skipped };
}

/**
 * Text blocks of one entry's message, in order.
 * @param {object} entry
 * @returns {string[]}
 */
function textBlocks(entry) {
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .filter((text) => text.trim().length > 0);
}

/**
 * @param {object[]} entries parsed transcript entries
 * @returns {string|null} the final assistant message, or null when there is none
 */
export function finalAssistantMessageFrom(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let last = entries.length - 1;
  while (last >= 0 && entries[last]?.type !== 'assistant') last -= 1;
  if (last < 0) return null;

  const requestId = entries[last].requestId;
  const run = [entries[last]];
  // Without a request id one entry is all we can honestly group: entries that
  // merely both lack the field are not thereby the same model turn.
  if (typeof requestId === 'string' && requestId.length > 0) {
    for (let i = last - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry?.type !== 'assistant' || entry.requestId !== requestId) break;
      run.unshift(entry);
    }
  }

  const text = run.flatMap(textBlocks).join('\n').trim();
  if (text.length === 0) return null;
  return truncateUtf8(text, {
    maxBytes: MAX_NARRATIVE_BYTES,
    marker: NARRATIVE_TRUNCATION_MARKER,
  }).text;
}

/**
 * @param {string} jsonlText raw transcript
 * @returns {string|null}
 */
export function extractFinalAssistantMessage(jsonlText) {
  return finalAssistantMessageFrom(parseTranscript(jsonlText).entries);
}

/**
 * Newest timestamp the transcript itself claims, in epoch milliseconds.
 *
 * Read from the entries rather than the file's mtime because a transcript can
 * be copied, restored, or touched long after the session that wrote it ended —
 * and staleness is a question about the CONVERSATION, not about the file. Null
 * when no entry carries a parseable timestamp; the caller then falls back to
 * the mtime, which is the only other evidence available.
 *
 * @param {object[]} entries
 * @returns {number|null}
 */
export function transcriptTimestamp(entries) {
  if (!Array.isArray(entries)) return null;
  let newest = null;
  for (const entry of entries) {
    const raw = entry?.timestamp;
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) continue;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}
