// text.mjs — shared text-shaping helpers for capping prompt payloads.
// Zero dependencies, pure functions.

/**
 * Tail the last `maxChars` characters of a string. Used across the toolkit
 * (consensus-fix's test output, parallax's route context, fence()'s
 * untrusted-content wrapping) wherever the END of a string is more likely
 * to matter than the start — a stack trace's failure line, a log's most
 * recent output.
 *
 * @param {string} str
 * @param {number} [maxChars]
 * @returns {string}
 */
export function tail(str, maxChars = 4000) {
  if (str.length <= maxChars) return str;
  return str.slice(str.length - maxChars);
}

/**
 * Wrap untrusted content (prior failure logs, prosecution findings, mined
 * PR text — anything not authored by the current agent) in an unguessable
 * fence so a prompt-construction site can declare it inert data, never
 * instructions (issue #281's broader concern; this is the mechanical half
 * already in use by packages/fleet).
 *
 * maxChars is REQUIRED (issue #280) — every existing call site had no cap,
 * so a single pathological log could blow a downstream context. Content is
 * tail()-biased when it needs truncation: for a build/gate/prosecution log,
 * the FAILURE is almost always at the end, not the start.
 *
 * @param {string} label
 * @param {string} content
 * @param {number} maxChars
 * @returns {string}
 */
export function fence(label, content, maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new Error('fence: maxChars must be a non-negative integer');
  }
  const raw = content ?? '';
  const capped = tail(raw, maxChars);
  const truncated = capped.length < raw.length;
  // The tag is derived from the CAPPED length (what's actually embedded),
  // not the original — the tag's whole purpose is to make the fence
  // unguessable from content the model doesn't control, and the model only
  // ever sees the capped content.
  const tag = `${label}-${capped.length}`;
  const marker = truncated ? `${label} (truncated, showing last ${maxChars} of ${raw.length} chars)` : label;
  return `<<UNTRUSTED:${marker}:${tag}>>\n${capped}\n<<END:${label}:${tag}>>`;
}
