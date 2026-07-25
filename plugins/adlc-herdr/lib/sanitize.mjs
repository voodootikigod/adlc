// Terminal-output sanitizer (plan §6.1). Everything the plugin renders into a
// terminal surface — status tokens, notifications, board text, pane titles —
// passes through here first. Input is untrusted (ticket bodies, branch names,
// log lines); the contract is frozen in test/sanitize.test.mjs (rail).
const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x9c;

/**
 * Bidirectional overrides, embeddings, isolates and directional marks — the
 * Trojan Source class (CVE-2021-42574). They make rendered text differ from
 * real text, which is why scripts/test/source-hygiene.test.mjs already refuses
 * them in source files. The same characters reaching a terminal from an
 * untrusted ticket title let a board row impersonate another ticket's id or
 * status, so an operator focuses the wrong pane.
 *
 * ZWJ (U+200D) and ZWNJ (U+200C) are deliberately absent: they are load-bearing
 * in Indic clusters and emoji sequences, and removing them corrupts real
 * content instead of protecting anyone.
 */
const isBidiControl = (code) => (code >= 0x202a && code <= 0x202e)
  || (code >= 0x2066 && code <= 0x2069)
  || code === 0x200e || code === 0x200f || code === 0x061c;

const isCsiParam = (c) => c >= 0x30 && c <= 0x3f;
const isCsiIntermediate = (c) => c >= 0x20 && c <= 0x2f;
const isCsiFinal = (c) => c >= 0x40 && c <= 0x7e;

/** Consume a CSI body (params, intermediates, final byte). `i` is the index
 *  just after the introducer. Returns the index just after the sequence. */
function consumeCsi(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (isCsiParam(c) || isCsiIntermediate(c)) { i += 1; continue; }
    if (isCsiFinal(c)) return i + 1;
    return i; // malformed: stop consuming, rescan from here
  }
  return i;
}

/** Consume an OSC/DCS/SOS/PM/APC string body until its terminator (ST always;
 *  BEL additionally for OSC) or end of input. */
function consumeString(text, i, { belTerminates }) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (belTerminates && c === BEL) return i + 1;
    if (c === ST) return i + 1;
    if (c === ESC && i + 1 < text.length && text[i + 1] === '\\') return i + 2;
    i += 1;
  }
  return i;
}

/**
 * Strip ANSI/OSC/C1/C0 escapes and controls from a string. Keeps `\n` and
 * `\t`; everything else below 0x20, DEL, and the C1 range is removed along
 * with any sequence body it introduces. Non-string input fails closed to ''.
 */
export function sanitize(value) {
  if (typeof value !== 'string') return '';
  const out = [];
  let i = 0;
  while (i < value.length) {
    const c = value.charCodeAt(i);
    if (c === ESC) {
      const next = i + 1 < value.length ? value[i + 1] : null;
      if (next === '[') i = consumeCsi(value, i + 2);
      else if (next === ']') i = consumeString(value, i + 2, { belTerminates: true });
      else if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        i = consumeString(value, i + 2, { belTerminates: false });
      } else i = next === null ? i + 1 : i + 2; // single-char escape or dangling ESC
      continue;
    }
    if (c === 0x9b) { i = consumeCsi(value, i + 1); continue; } // 8-bit CSI
    if (c === 0x9d) { i = consumeString(value, i + 1, { belTerminates: true }); continue; } // 8-bit OSC
    if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) { // DCS/SOS/PM/APC
      i = consumeString(value, i + 1, { belTerminates: false });
      continue;
    }
    if (c >= 0x80 && c <= 0x9f) { i += 1; continue; } // other C1
    if (c === 0x7f) { i += 1; continue; } // DEL
    if (isBidiControl(c)) { i += 1; continue; } // Trojan Source — see above
    if (c < 0x20 && c !== 0x0a && c !== 0x09) { i += 1; continue; } // C0 except \n \t
    out.push(value[i]);
    i += 1;
  }
  return out.join('');
}

/**
 * Sanitize a string destined for a single-line surface (a status token, a
 * notification title): strip escapes, collapse all whitespace to single
 * spaces, trim, and hard-cap the length. Fails closed ('') on non-string
 * input or a non-positive cap.
 */
export function sanitizeToken(value, maxLength = 64) {
  if (typeof value !== 'string') return '';
  if (!Number.isFinite(maxLength) || maxLength <= 0) return '';
  return sanitize(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
